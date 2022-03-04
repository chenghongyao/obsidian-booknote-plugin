import {Menu, normalizePath, Notice,Platform,Plugin, TAbstractFile, TFile, TFolder, ViewCreator} from "obsidian";
import { around } from "monkey-around";

import { BookMasterSettings,DEFAULT_SETTINGS,DeviceSetting,DEFAULT_DEVICE_SETTINGS } from "./settings";
import * as utils from './utils'
import { OB_BOOKVAULT_ID } from "./constants";
import { AbstractBook, Book, BookFolder, BookStatus, BookTreeSortType } from "./Book";
import { BookExplorer, VIEW_TYPE_BOOK_EXPLORER } from "./view/BookExplorer";


export default class BookMasterPlugin extends Plugin {
	settings: BookMasterSettings;
	root: {[vid:string]:BookFolder};
	dispTree: BookFolder; // FIXME:parent of book item in dispTree is wrong

	bookMap: {[path:string]:AbstractBook} = {};
	bookIdMap: {[bid:string]:Book} = {};
	
	async onload() {
		await this.loadSettings();

		this.loadAllBookVaults().then(()=>{
			new Notice(`有${this.root["00"].children.length}个文件`);

			// for(var key in this.bookMap) {
			// 	const book = this.bookMap[key];
			// 	if (!book.isFolder()) {
			// 		(book as Book).meta.tags = ["aa","aa/bb","cc/bb"];
			// 		this.saveBookData(book as Book).then(()=>{
			// 		})
			// 		break;
			// 	}
			// }


		});
	
		this.addRibbonIcon("dice","BookExplorer",(evt) => {
			this.activateView(VIEW_TYPE_BOOK_EXPLORER,"left");
			
		});

		this.safeRegisterView(VIEW_TYPE_BOOK_EXPLORER,leaf => new BookExplorer(leaf,this));
	}

	onunload() {
	}

	// register view safely
	private safeRegisterView(type: string, viewCreator: ViewCreator) {
		this.registerView(type, viewCreator);
		this.register(() => {
			this.app.workspace.detachLeavesOfType(type);
		});
	}

	async activateView(type: string, dir?: string, split?: boolean) {

		if (this.app.workspace.getLeavesOfType(type).length == 0) { // if dont exists, create new one,
			var leaf;
			if (dir === "left") {
				leaf = this.app.workspace.getLeftLeaf(split);
			} else if (dir === "right") {
				leaf = this.app.workspace.getRightLeaf(split);
			} else {
				leaf = this.app.workspace.getLeaf(split && !(this.app.workspace.activeLeaf.view.getViewType() === "empty"));
			}
			await leaf.setViewState({
				type: type,
				active: true,
			});
		}

		this.app.workspace.revealLeaf(this.app.workspace.getLeavesOfType(type)[0]);
	}

	private getBookVaultPath(vid: string) {
		if (vid === OB_BOOKVAULT_ID) {
			return (this.app.vault.adapter as any).basePath;
		} else {
			const vaultPath = this.getCurrentDeviceSetting().bookVaultPaths[vid];
			if (vaultPath.startsWith("@")) {
				return (this.app.vault.adapter as any).basePath + vaultPath.substring(1);
			} else {
				return vaultPath;
			}
		}
	}
	
	private getBookVaultName(vid: string) {
		if (vid === OB_BOOKVAULT_ID) {
			return this.app.vault.getName();
		} else {
			return this.settings.bookVaultNames[vid] || utils.getDirName(this.getBookVaultPath(vid));
		}
	}
	private getBookDataPath() {
		return this.settings.dataPath + "/book-data";
	}

	private async getBookByPath(vid: string, path: string) {
		const entry = `${vid}:${path}`;
		if (this.root) {	// FIXME: check book vault load status
			return this.bookMap[entry];
		} else {
			return this.loadAllBookVaults().then(() => {
				return this.bookMap[entry];
			});
		}
	}

	private async getBookById(bid: string) {
		if (this.root) {	 // FIXME: check book vault load status
			return this.bookIdMap[bid];
		} else {
			return this.loadAllBookVaults().then(() => {
				return this.bookIdMap[bid];
			});
		}
	}

	private getCurrentDeviceSetting() {
		return this.settings.deviceSetting[utils.appId];
	}


	// TODO: async,too slow
	private async walkBookVault(vid:string, vaultPath: string, rootPath: string, root: BookFolder,map: {[path:string]:AbstractBook}, validBookExts: Array<string>) {

		for (var i = 0; i < root.children.length; i++) {  // set all test flag of children to false
			const abs = root.children[i];
			abs._existsFlag = false;
		}

		const dirpath = utils.normalizePath(vaultPath,rootPath);
		const files = Platform.isMobile ? await utils.fs.readdir(dirpath) : utils.fs.readdirSync(dirpath);

		for(var i = 0; i < files.length; i++) {
			const name = files[i];
			const path = rootPath+"/"+name;
			const entry = `${vid}:${path}`;

			if (await utils.isFolder(utils.normalizePath(vaultPath,path))) {
				if (name.startsWith(".")) continue;

				var folder = map[entry];
				if (!folder || !folder.isFolder()) {		// new folder
					folder = new BookFolder(root,vid,name,path);
					root.push(folder);
					map[entry] = folder;	
				}

				folder._existsFlag = true;
				await this.walkBookVault(vid,vaultPath,path,folder as BookFolder,map,validBookExts);
			} else {
				const ext = utils.getExtName(path);
				if (!utils.isValidBook(name,ext,validBookExts)) continue;

				var book = map[entry] as Book;
				if (!book || book.isFolder()) {	// new file
					const bookname = name.substring(0,ext.length? name.length - ext.length-1:name.length);
					book = new Book(root,vid, path,bookname,ext);
					book.loadBookData(null); // init book data
					root.push(book);
					map[entry] = book;
				}

				book._existsFlag = true;
			}
		}

		// if the test flag is still false, then it has been deleted
		for (var i = 0; i < root.children.length; i++) {  
			const abs = root.children[i];
			if (abs._existsFlag || abs.lost) continue;

			const entry = `${abs.vid}:${abs.path}`;
			delete map[entry];
			root.children.splice(i,1);

			if (abs.isFolder()) {
				utils.cleanFolderInMap(abs as BookFolder,map);
			} 
		}
	}

	private getBookFolder(vid:string, path: string, rootFolder: BookFolder) {
		
		const nodes = path.substring(1).split("/"); // path start with '/'
		var p = "";
		var folder = rootFolder;

		for(let i = 0; i < nodes.length-1; i++) {
			p += "/" + nodes[i];
			const entry = `${vid}:${p}`;
			
			var f = this.bookMap[entry];
			if (!f || !f.isFolder()) {
				f = new BookFolder(folder,vid,nodes[i],path,true);
				folder.push(f);
				this.bookMap[entry] = f;
			}
			folder = f as BookFolder;
		}
		return folder;
	}


	// save book data safely
	async saveBookData(book: Book) {
		if (!book.hasId()) {
			const bid = book.getId();
			this.bookIdMap[bid] = book;
		}
		return book.saveBookData(this.getBookDataPath());
	}

	async getBookId(book: Book) {
		if (!book.hasId()) {
			const bid = book.getId();
			this.bookIdMap[bid] = book;
			return this.saveBookData(book).then(() => {
				return bid;
			});
		}
		return book.getId();
	}

	private async loadAllBookData() {
		const dataFolder = this.app.vault.getAbstractFileByPath(this.getBookDataPath()) as TFolder;
		if (!dataFolder || !(dataFolder instanceof TFolder)) return;
		for(var i = 0 ;i < dataFolder.children.length; i++) {
			const file = dataFolder.children[i];
			if (!(file instanceof TFile)) continue;
			const meta = await this.app.metadataCache.getFileCache(file as TFile).frontmatter;
			if (!meta["book-meta"]) continue;

			const {vid,bid,path,name,ext,visual} = meta;
			if (!this.root[vid] || !vid || !bid)continue;

			const entry = `${vid}:${path}`;
			var book = this.bookIdMap[bid];
			if (book) {
				// move book when change vid or path manually, which should not happen
				if (book.vid !== vid || book.path !== path) { 
					book.parent.children.remove(book);
					book.vid = vid;
					book.path = path;
					if (this.root[vid]) {
						const folder = this.getBookFolder(vid,book.path,this.root[vid]) // exist root[vid]?
						book.parent = folder;
						folder.push(book);
					}
				}

				book.lost = !Boolean(this.bookMap[entry])	// update book lost flag
				// FIXME: reload book data??
			} else {
				book = this.bookMap[entry] as Book;
				if (!book || book.isFolder()) {   // this book is lost
					const folder = this.getBookFolder(vid,path,this.root[vid]);
					book = new Book(folder,vid,path,name,ext,bid,visual,true);
					folder.push(book);
					// this.bookMap[entry] = book;  // dont record lost book
				}				
				this.bookIdMap[bid] = book;
			}

			book.loadBookData(meta);
			// FIXME: what if some of bid are deleted??
		}
	}

	private async loadBookVault(vid: string) {
		const vaultPath = this.getBookVaultPath(vid);
		const vaultName = this.getBookVaultName(vid) || utils.getDirName(vaultPath);
		if (!await utils.isFolderExists(vaultPath)) { // TODO: virtual vault
			new Notice(`书库“${vaultName}(${vid}):${vaultPath}”不存在`); 
			return;
		}		


		if (!this.root[vid]) {
			this.root[vid] = new BookFolder(null,vid,vaultName,null);	
		}
		
		return this.walkBookVault(vid,vaultPath,"",this.root[vid],this.bookMap,this.settings.validBookExts);
	}

	async loadAllBookVaults() {

		new Notice("书库加载中...");

		if (!this.root) {
			this.root = {};
		}

		// load book file
		for(const vid in this.getCurrentDeviceSetting().bookVaultPaths) {
			await this.loadBookVault(vid); //FIXME: continue if path is empty??
		}

		await this.loadBookVault(OB_BOOKVAULT_ID);

		// load book data
		await this.loadAllBookData();


		await this.updateDispTree();

		console.log(this.root);
		console.log(this.bookMap);
		console.log(this.bookIdMap);

		new Notice("书库加载完成");
	}


	async updateDispTree() {
		if (!this.root) {
			return this.loadAllBookData();
		}

		const vid = this.settings.currentBookVault;
		if (!this.root[vid]) {
			throw "当前书库不存在"; // TODO
		}

		const rawTree = this.root[vid];
		if (!this.dispTree) {
			this.dispTree = new BookFolder(null,vid,this.getBookVaultName(vid),null);
		}

		// clear
		this.dispTree.children.length = 0;

		// built
		if (this.settings.bookTreeSortType === BookTreeSortType.PATH) {
			utils.walkTreeByFolder(this.root[vid],this.dispTree); // TODO: check setup
		} else {
			const map: Map<string,BookFolder> = new Map();
			const unknownFolder = new BookFolder(this.dispTree,vid,"unknown","unknown");
			map.set("unknown", unknownFolder);
			this.dispTree.push(unknownFolder);
		
			if (this.settings.bookTreeSortType === BookTreeSortType.TAG) {
				utils.walkTreeByTag(map,rawTree,this.dispTree);
			} else if (this.settings.bookTreeSortType === BookTreeSortType.AUTHOR) {
				utils.walkTreeByAuthor(map,rawTree,this.dispTree);
			} else if (this.settings.bookTreeSortType === BookTreeSortType.PUBLISH_YEAR) {
				utils.walkTreeByPublishYear(map,rawTree,this.dispTree);
			}
		}

		utils.accumulateTreeCount(this.dispTree);
		utils.sortBookTree(this.dispTree,this.settings.bookTreeSortAsc);

	}

	private getBookFullPath(book: Book) {
		// FIXME: url path
		return utils.normalizePath(this.getBookVaultPath(book.vid),book.path);
	}

	private getBookOpenLink(book: Book) {
		return this.getBookId(book).then((bid) => {
			return `obsidian://bookmaster?type=open-book&${bid}`;
		})
	}


	private async openMdFileInObsidian(path: string) {
		const leaf = this.app.workspace.getLeaf();
		await leaf.setViewState({
			type: 'markdown',
			state: {
				file: path,
			}
		});
	}

	private getBookDataFilePath(book: Book) {
		return this.getBookDataPath() + `/${book.bid}.md`;
	}

	private async openBookDataFile(book: Book) {
		if (!book.vid) {
			Promise.reject("empty vid");
			return;
		}
		return this.getBookId(book).then((bid) => {
			return this.openMdFileInObsidian(this.getBookDataFilePath(book));
		})

	}

	createBookContextMenu(menu: Menu, book: Book) {
		if (book.vid) {

			if (book.lost) {
				menu.addItem((item: any) =>
				item
					.setTitle("重定位文件(todo)")
					.setIcon("popup-open")
					.onClick(()=>{
						// TODO: relocate book
					})
				);
				menu.addSeparator();
			}

			menu.addItem((item: any) =>
			item
				.setTitle("基本设置(todo)")
				.setIcon("gear")
				.onClick(()=>{
					// new BasicBookSettingModal(this.app,this,book).open();
				})
			);

			menu.addItem((item: any) =>
			item
				.setTitle("打开设置文件")
				.setIcon("popup-open")
				.onClick(()=>{
					this.openBookDataFile(book);
				})
			);

			menu.addItem((item) =>
			item
				.setTitle((book.meta.note ? "打开笔记" : "创建笔记") + "(todo)")
				.setIcon("pencil")
				.onClick(()=>{
					// this.createBookNote(book);
				})
			);
			menu.addSeparator();

			// TODO: icon
			const allStatus = [BookStatus.UNREAD,BookStatus.READING,BookStatus.FINISHED];
			const statusIcon = ["cross","clock","checkmark"]
			const statusName = ["未读","在读","已读"];
			const bookStatus = allStatus.includes(book.meta["status"]) ? book.meta["status"] : BookStatus.UNREAD;
			for (let ind in allStatus) {
				const status = allStatus[ind];
				if (bookStatus !== status) {
					menu.addItem((item) =>
					item
						.setTitle("设为"+statusName[ind])
						.setIcon(statusIcon[ind])
						.onClick(()=>{
							book.meta["status"] = status;
							console.log(book.meta);
							this.saveBookData(book).then(() => {
								new Notice("设置成功");
							}).catch((reason)=>{
								new Notice("设置失败:\n"+reason);
							});
						})
					);
				}
			}

			menu.addSeparator();
			menu.addItem((item) =>
			item
				.setTitle("复制路径(ID)")
				.setIcon("link")
				.onClick(()=>{
					this.getBookId(book).then((id: string) => {
						navigator.clipboard.writeText(id);
					})
				})
			);
	
			menu.addItem((item) =>
			item
				.setTitle("复制Obsidian链接(todo)")
				.setIcon("link")
				.onClick(()=>{
					this.getBookOpenLink(book).then((link) => {
						navigator.clipboard.writeText(`[${book.meta.title || book.meta.name}](${link})`);
					})
				})
			);

			menu.addItem((item) =>
			item
				.setTitle("引用(todo)")
				.setIcon("link")
				.onClick(()=>{
					// if (book.meta.citekey) {
					// 	navigator.clipboard.writeText(`[@${book.meta.citekey}]`);
					// } else {
					// 	new Notice("请先设置citekey");
					// }
				})
			);
			menu.addSeparator();
			if (book.bid) {
				menu.addItem((item: any) =>
				item
					.setTitle("删除记录(todo)")
					.setIcon("trash")
					.onClick(()=>{
						// TODO: double check
						// const file = this.app.vault.getAbstractFileByPath(this.getBookManifestPath(book)) as TFile;
						// if (file) {
						// 	this.app.vault.delete(file.parent,true).then(() => {
						// 		// this.updateBookMeta(book); read from file cache work, need to wait for some second?
						// 	})
						// }
					})
				);	

				menu.addItem((item: any) =>
				item
					.setTitle("删除文件(todo)")
					.setIcon("trash")
					.onClick(()=>{
						// TODO: double check
						// const file = this.app.vault.getAbstractFileByPath(this.getBookManifestPath(book)) as TFile;
						// if (file) {
						// 	this.app.vault.delete(file.parent,true);
						// }
						// this.updateBookMeta(book);
					})
				);
			}
			
		}

		if (!book.lost) {
			menu.addSeparator();
			menu.addItem((item: any) =>
			item
				.setTitle("使用默认应用打开")
				.setIcon("popup-open")
				.onClick(()=>{
					this.openBookBySystem(book);
				})
			);
	
			if (book.vid && !book.visual) {
				menu.addItem((item: any) =>
				item
					.setTitle("在系统资源管理器中显示(todo)")
					.setIcon("popup-open")
					.onClick(()=>{
						// this.showBookLocationInSystem(book);
						
					})
				)
			};
	
		}



	}


	private async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.deviceSetting[utils.appId]) {
			this.settings.deviceSetting[utils.appId] = Object.assign({},DEFAULT_DEVICE_SETTINGS);
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	private getMobileRelativePath(fullpath: string) {
		const basePath = this.getBookVaultPath(OB_BOOKVAULT_ID);
		const b = basePath.split("/");
		const f = fullpath.split("/");
		for (var i = 0; i < b.length; i++) {
			if (b[i] !== f[i]) {
				const rel = "../".repeat(b.length-i) + f.slice(i).join("/");
				return rel;
			}
		}
		
		if (f.length > b.length) {
			return f.slice(b.length).join("/");
		} else {
			return null;
		}
	}
	async openBookBySystem(book: Book) {
		const fullpath = this.getBookFullPath(book);

		if (Platform.isMobile) {
			// TODO: http?
			const relPath = this.getMobileRelativePath(fullpath);
			(this.app as any).openWithDefaultApp(relPath);
		} else {
			window.open(fullpath);
		}
	}
	async openBook(book: Book, newPanel: boolean = false) {
		if (book.lost) {
			// TODO: fix lost book
			new Notice("文件丢失");
			return;
		}

		this.openBookBySystem(book);
	}


}
