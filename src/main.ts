import {MarkdownView, Menu, normalizePath, Notice,Platform,Plugin, TAbstractFile, TFile, TFolder, ViewCreator} from "obsidian";
import { around } from "monkey-around";

import { BookMasterSettings,DEFAULT_SETTINGS,DeviceSetting,DEFAULT_DEVICE_SETTINGS } from "./settings";
import * as utils from './utils'
import { OB_BOOKVAULT_ID } from "./constants";
import { AbstractBook, Book, BookFolder, BookStatus, BookTreeSortType } from "./Book";
import { BookExplorer, VIEW_TYPE_BOOK_EXPLORER } from "./view/BookExplorer";
import BasicBookSettingModal from "./view/BasicBookSettingModal";
import BookSuggestModal from "./view/BookSuggestModal";
import { BookProject, VIEW_TYPE_BOOK_PROJECT } from "./view/BookProject";


export default class BookMasterPlugin extends Plugin {
	settings: BookMasterSettings;
	root: {[vid:string]:BookFolder};
	dispTree: BookFolder; // FIXME:parent of book item in dispTree is wrong

	bookMap: {[path:string]:AbstractBook} = {};
	bookIdMap: {[bid:string]:Book} = {};

	currentBookProjectFile: TFile;
	currentBookProjectBooks: BookFolder;
	
	async onload() {
		await this.loadSettings();

		this.loadAllBookVaults().then(()=>{
		});
	
		this.addRibbonIcon("dice","BookExplorer",(evt) => {
			this.activateView(VIEW_TYPE_BOOK_EXPLORER,"left");
		});

		this.addCommand({
			id: "bm-search-book",
			name: "Search Book",
			checkCallback: (checking) => {
				const tree = this.root[this.settings.currentBookVault];
				if (checking) {
					return Boolean(tree);
				} else {
					new BookSuggestModal(this.app, this,tree).open();
					return true;
				}
			}

		});


		this.registerBookProject();

		this.safeRegisterView(VIEW_TYPE_BOOK_EXPLORER,leaf => new BookExplorer(leaf,this));
		this.safeRegisterView(VIEW_TYPE_BOOK_PROJECT,leaf => new BookProject(leaf,this));
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
	private getPropertyValue(file: TFile, propertyName: string) {
		if (!file) {
			return null;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.[propertyName];
	}

	private isProjectFile(file: TFile) {
		return file && (this.getPropertyValue(file, "bookmaster-plugin") || this.getPropertyValue(file,"bm-books"));
	}

	private searchProjectFile(f: TFile) {
		if (this.isProjectFile(f)) {
			return f;
		}
		if (!f.parent.name) {
			return
		}
		const folderFilePath = normalizePath(f.parent.path + `/${f.parent.name}.md`);
		const folderFile = this.app.vault.getAbstractFileByPath(folderFilePath) as TFile
		if (folderFile && this.isProjectFile(folderFile)) {
			return folderFile;
		} else {
			return;
		}
	}

	async updateBookProject() {
		// TODO: project file is deleted
		if (!this.currentBookProjectFile) {
			new Notice("没有设置工程文件");
			return
		}
		const projectName = this.getPropertyValue(this.currentBookProjectFile, "bm-name")  || this.currentBookProjectFile.basename
		if (!this.currentBookProjectBooks) {
			this.currentBookProjectBooks = new BookFolder(null,null,projectName,null,);
		} else {
			this.currentBookProjectBooks.name = projectName;
			this.currentBookProjectBooks.removeAll();
		}
		
		let books = this.getPropertyValue(this.currentBookProjectFile, "bm-books");
		if (!books) return;

		if (typeof books === "string") books = [books];

		for (let i = 0; i < books.length; i++) {
			const regIdPath = /[a-zA-Z0-9]{16}/;
			const IdPathGroup = regIdPath.exec(books[i]);
			if (IdPathGroup) {
				const book = await this.getBookById(IdPathGroup[0]);
				if (book) {
					this.currentBookProjectBooks.push(book);
				}
				continue;
			} 

			const regUrl = /^\[(.*)\]\((https?:\/\/[\w\-_]+(?:\.[\w\-_]+)+[\w\-\.,@?^=%&:/~\+#]*[\w\-\@?^=%&/~\+#])?\)$/
			const urlGroup = regUrl.exec(books[i]);
			if (urlGroup) {
				const book = new Book(null,null,urlGroup[2],urlGroup[1],"url",null);
				this.currentBookProjectBooks.push(book);
				continue;
			}
			

		}
	}


	private async openBookInProject() {
		// FIXME: need update?
		return this.updateBookProject().then(() => {
			const count = this.currentBookProjectBooks.children.length;
			if (count === 1) {
				this.openBook(this.currentBookProjectBooks.children[0] as Book);
			} else if (count > 0) {
				new BookSuggestModal(this.app, this, this.currentBookProjectBooks).open();
			} else {
				new Notice("当前工程没有文件");
			}
		});
	}

	private registerBookProject() {
		const self = this;
		// add item in more options
		this.register(
			around(MarkdownView.prototype, {
				onMoreOptionsMenu(next) {
					return function (menu: Menu) {
						// book meta file
						if (self.getPropertyValue(this.file,"bm-meta")) { 
							const meta = self.app.metadataCache.getFileCache(this.file)?.frontmatter;
							const {vid,bid} = meta;
							if (vid && bid) {
								menu.addItem((item) => {
									item.setTitle("Open This Book").setIcon("popup-open") .onClick(() => {	
										self.getBookById(bid).then((book) => {
											self.openBook(book);
										}).catch((reason) => {
											new Notice("cant get this book:\n"+reason);
										});
									});
								});	
								menu.addItem((item) => {
									item.setTitle("基本设置").setIcon("gear").onClick((evt) => {	
										self.getBookById(bid).then((book) => {
											new BasicBookSettingModal(self.app,self,book,this.leaf.view.contentEl.getBoundingClientRect()).open();
										});
									});
								});	
							}

							menu.addSeparator();
						} else {


							const projFile = self.searchProjectFile(this.file);
							if (projFile) {
								menu.addItem((item) => {
									item.setTitle("Open Book Project").onClick(() => {
										self.currentBookProjectFile = projFile;
										self.updateBookProject().then(() => {
											self.activateView(VIEW_TYPE_BOOK_PROJECT, "right");
										});
									});
								});
		
								let books = self.getPropertyValue(projFile, "bm-books");
								if (typeof books === "string") books = [books];

								if (books && books.length > 0 && books[0]) {
									menu.addItem((item) => {
										item.setTitle("Open Book In Project").onClick(() => {	
											self.currentBookProjectFile = projFile;
											self.openBookInProject();
											
											
										});
									});
								}
								menu.addSeparator();
							}
						}
						return next.call(this, menu);
					};
				},
			})
		);	


		this.addCommand({
			id: 'open-book-from-meta-file',
			name: 'Open This Book',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!markdownView || !markdownView.file || !self.getPropertyValue(markdownView.file,"bm-meta")) return  false;

				const meta = self.app.metadataCache.getFileCache(markdownView.file)?.frontmatter;
				const {vid,bid} = meta;
				if (vid && bid) {
					if (!checking) {
						self.getBookById(bid).then((book) => {
							self.openBook(book);
						}).catch((reason) => {
							new Notice("cant get this book:\n"+reason);
						});
					}
	
					return true;
				} else {
					return false;
				}

		
			}
		});

		this.addCommand({
			id: 'open-book-project',
			name: 'Open Book Project',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!markdownView || !markdownView.file) return  false;
				const projFile = self.searchProjectFile(markdownView.file);

				if (!projFile) return false;

				if (!checking) {
					self.currentBookProjectFile = projFile;
					self.updateBookProject().then(() => {
						self.activateView(VIEW_TYPE_BOOK_PROJECT, "right");
					});
				}

				return true;
			}
		});

		// quick command for opening first book
		this.addCommand({
			id: 'open-book-in-project',
			name: 'Open Book In Project',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!markdownView || !markdownView.file) return  false;


				const projFile = self.searchProjectFile(markdownView.file);
				if (!projFile) return false;

				if (!checking) {
					self.currentBookProjectFile = projFile;
					self.openBookInProject();
				}
				return true;
			} 
			
		});
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
		if (this.root) {	
			return this.bookMap[entry];
		} else {
			return this.loadAllBookVaults().then(() => {
				return this.bookMap[entry];
			});
		}
	}

	private async getBookById(bid: string) {
		if (this.root) {	 
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
			// new Notice("创建id:"+bid);
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
			if (!meta["bm-meta"]) continue;

			const {vid,bid,path,name,ext,visual} = meta;
			if (!vid || !bid)continue; // FIXME: check path?

			const entry = `${vid}:${path}`;
			var book = this.bookIdMap[bid];
			if (book) { // old data file
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
				// FIXME: need reload book data??
			} else if (this.root[vid]) { // new book data file
				book = this.bookMap[entry] as Book;
				if (!book || book.isFolder()) {   // this book is lost
					const folder = this.getBookFolder(vid,path,this.root[vid]);
					book = new Book(folder,vid,path,name,ext,bid,visual,true);
					folder.push(book);
				}				
				this.bookIdMap[bid] = book;
			} else { 
				console.warn("unvalid data file(vid):",meta);
				continue;
			}

			book.loadBookData(meta); // FIXME: always load book
			// FIXME: data file is deleted manualy??
		}
	}

	private async loadBookVault(vid: string) {
		const vaultPath = this.getBookVaultPath(vid);
		if (!vaultPath) return; // FIXME: ignore this vault
		const vaultName = this.getBookVaultName(vid);
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

		if (!this.root) {	// first load
			this.root = {};
		}

		// load book file
		for(const vid in this.getCurrentDeviceSetting().bookVaultPaths) {
			await this.loadBookVault(vid);
		}

		await this.loadBookVault(OB_BOOKVAULT_ID); // TODO: don't load this vault

		// load book data
		await this.loadAllBookData();


		await this.updateDispTree();
		console.log(this.root);
		console.log(this.bookIdMap);

		new Notice("书库加载完成");
	}

	// async updateCurrentBookVault() {
	// 	if (!this.root) {	// first load
	// 		this.root = {};
	// 	}

	// 	return this.loadBookVault(this.settings.currentBookVault).then(() => {
	// 		return this.loadAllBookData().then(() => { // TODO: only load book of current vault??
	// 			return this.updateDispTree();
	// 		})
	// 	})
	// }


	async updateDispTree() {
		if (!this.root) { // FIXME: can this happen??
			return this.loadAllBookVaults();
		}

		const vid = this.settings.currentBookVault;
		if (!this.root[vid]) {
			throw "当前书库不存在"; // TODO
		}

		const rawTree = this.root[vid];
		if (!this.dispTree) {
			this.dispTree = new BookFolder(null,vid,this.getBookVaultName(vid),null);
		} else if (vid !== this.dispTree.vid) {
			this.dispTree.vid = vid;
			this.dispTree.name = this.getBookVaultName(vid);
		}

		// clear
		this.dispTree.removeAll();

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

	private async getBookOpenLink(book: Book) {
		return this.getBookId(book).then((bid) => {
			return `obsidian://bookmaster?type=open-book&bid=${bid}`;
		});
	}

	private getBookDataFilePath(book: Book) {
		return this.getBookDataPath() + `/${book.bid}.md`;
	}

	private async openBookDataFile(book: Book) {
		return this.getBookId(book).then((bid) => {
			return utils.openMdFileInObsidian(this.getBookDataFilePath(book));
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
				.setTitle("基本设置")
				.setIcon("gear")
				.onClick(()=>{
					new BasicBookSettingModal(this.app,this,book).open();
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
				.setTitle("复制路径(ID:Title)")
				.setIcon("link")
				.onClick(()=>{
					this.getBookId(book).then((id: string) => {
						navigator.clipboard.writeText(`"${id}:${book.meta.title || book.name}"`);
					})
				})
			);
	
			menu.addItem((item) =>
			item
				.setTitle("复制Obsidian链接")
				.setIcon("link")
				.onClick(()=>{
					this.getBookOpenLink(book).then((link) => {
						navigator.clipboard.writeText(`[${book.meta.title || book.name}](${link})`);
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
			menu.addItem((item: any) =>
			item
				.setTitle("打开设置文件")
				.setIcon("popup-open")
				.onClick(()=>{
					this.openBookDataFile(book);
				})
			);

			if (book.hasId()) {
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
			}

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
				

			if (book.vid && !book.visual && !Platform.isMobile) {
				menu.addItem((item: any) =>
				item
					.setTitle("在系统资源管理器中显示")
					.setIcon("popup-open")
					.onClick(()=>{
						// FIXME: http?
						utils.showBookLocationInSystem(this.getBookFullPath(book));
						
					})
				)
			};
	
		}
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
		if (book.ext === "url") {
			if (Platform.isMobile) {
				(this.app as any).openWithDefaultApp(book.path);
			} else {
				window.open(book.path);
			}
		} else {
			const fullpath = this.getBookFullPath(book);
			if (Platform.isMobile) {
				// TODO: http?
				const relPath = this.getMobileRelativePath(fullpath);
				(this.app as any).openWithDefaultApp(relPath);
			} else {
				window.open(fullpath);
			}
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
}
