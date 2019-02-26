import * as path from 'path'
import * as minimatch from 'minimatch'

import {
	TextDocuments,
	TextDocument,
	Connection,
	TextDocumentChangeEvent,
	Files,
	DidChangeWatchedFilesParams,
	FileChangeType
} from 'vscode-languageserver'

import {readText, glob, getStat, timer} from './util'
import Uri from 'vscode-uri'


export interface TrackMapItem {
	document: TextDocument | null

	//when file was tracked, version=0
	//after file read from disk, version=1
	//after first opening, version=1
	//after been edited in vscode, version always > 1
	//and we will restore version to 1 after closed
	//so version=1 means have read and not been opened or just opened without any edit
	version: number

	//if file opened, it can capture file system changes and trigger onDidChangeContent
	opened: boolean

	fresh: boolean

	//update request may come from track, or beFresh, we cant makesure they will have no conflict
	//so we need a promise to lock it to avoid two update task are executed simultaneously
	updatePromise: Promise<void> | null
}

export interface FileTrackerOptions {
	connection: Connection
	documents: TextDocuments
	includeGlobPattern: string
	excludeGlobPattern?: string
	updateImmediately?: boolean
	startPath: string | undefined
}

export class FileTracker {

	private includeGlobPattern: string
	private excludeGlobPattern: string | undefined
	private updateImmediately: boolean
	private startPath: string | undefined

	private includeMatcher: minimatch.IMinimatch
	private excludeMatcher: minimatch.IMinimatch | null

	private map: Map<string, TrackMapItem> = new Map()
	private ignoredFilePaths: Set<string> = new Set()
	private allFresh: boolean
	private startPathLoaded: boolean

	constructor(options: FileTrackerOptions) {
		if (options.includeGlobPattern && path.isAbsolute(options.includeGlobPattern)) {
			throw new Error(`includeGlobPattern parameter "${options.includeGlobPattern}" should not be an absolute path pattern`)
		}

		this.includeGlobPattern = options.includeGlobPattern || '**/*'
		this.excludeGlobPattern = options.excludeGlobPattern
		this.includeMatcher = new minimatch.Minimatch(this.includeGlobPattern)
		this.excludeMatcher = this.excludeGlobPattern ? new minimatch.Minimatch(this.excludeGlobPattern) : null
		this.updateImmediately = options.updateImmediately || false
		this.startPath = options.startPath
		this.startPathLoaded = !this.startPath
		this.allFresh = this.startPathLoaded

		if (this.startPath && this.updateImmediately) {
			this.loadStartPath()
		}

		options.documents.onDidChangeContent(this.onDocumentOpenOrContentChanged.bind(this))

		//seems onDidSave not work
		options.documents.onDidSave(this.onDocumentSaved.bind(this))

		options.documents.onDidClose(this.onDocumentClosed.bind(this))
		options.connection.onDidChangeWatchedFiles(this.onWatchedPathChanged.bind(this))
	}

	has(filePath: string): boolean {
		return this.map.has(filePath)
	}

	private async loadStartPath() {
		await this.trackPath(this.startPath!)
		this.startPathLoaded = true
	}

	//no need to handle file opening because we have preloaded all the files
	//open and changed event will be distinguished by document version later
	private onDocumentOpenOrContentChanged(event: TextDocumentChangeEvent) {
		let document = event.document
		let filePath = Files.uriToFilePath(document.uri)

		if (filePath && this.canTrackFilePath(filePath)) {
			this.trackOpenedFile(filePath, document)
		}
	}

	private canTrackFilePath(filePath: string): boolean {
		if (!this.includeMatcher.match(filePath)) {
			return false
		}

		if (this.excludeMatcher && this.excludeMatcher.match(filePath)) {
			return false
		}

		return true
	}

	private canTrackPath(fileOrFolderPath: string): boolean {
		if (this.excludeMatcher && this.excludeMatcher.match(fileOrFolderPath)) {
			return false
		}

		return true
	}

	private onDocumentSaved(event: TextDocumentChangeEvent) {
		let document = event.document
		let filePath = Files.uriToFilePath(document.uri)
		let item = this.map.get(filePath!)

		//since onDidChangeWatchedFiles event was triggered so frequently, we only do updating after saving
		if (item && !item.fresh && this.updateImmediately) {
			this.doUpdate(filePath!, item)
		}
	}

	private onDocumentClosed(event: TextDocumentChangeEvent) {
		let document = event.document
		let filePath = Files.uriToFilePath(document.uri)
		this.unTrackOpenedFile(filePath!)
	}

	//no need to handle file changes making by vscode when document is opening, and document version > 1 at this time
	private async onWatchedPathChanged(params: DidChangeWatchedFilesParams) {
		for (let change of params.changes) {
			let uri = change.uri
			let fileOrFolderPath = Files.uriToFilePath(uri)

			if (!fileOrFolderPath) {
				continue
			}

			if (change.type === FileChangeType.Created) {
				this.trackPath(fileOrFolderPath)
			}
			else if (change.type === FileChangeType.Changed) {
				let stat = await getStat(fileOrFolderPath)
				if (stat.isFile()) {
					let filePath = fileOrFolderPath
					if (this.canTrackFilePath(filePath)) {
						this.reTrackFile(filePath)
					}
				}
			}
			else if (change.type === FileChangeType.Deleted) {
				this.unTrackPath(fileOrFolderPath)
			}
		}
	}

	private async trackPath(fileOrFolderPath: string) {
		if (!this.canTrackPath(fileOrFolderPath)) {
			return
		}

		let stat = await getStat(fileOrFolderPath)
		if (stat.isDirectory()) {
			await this.trackFolder(fileOrFolderPath)
		}
		else if (stat.isFile()) {
			let filePath = fileOrFolderPath
			if (this.canTrackFilePath(filePath)) {
				await this.trackFile(filePath)
			}
		}
	}
	
	private async trackFolder(folderPath: string) {
		let filePaths = await this.getFilePathsInFolder(folderPath)
		for (let filePath of filePaths) {
			this.trackFile(filePath)
		}
	}
	
	private async getFilePathsInFolder(folderPath: string): Promise<string[]> {
		let cssFilePaths = await glob(`${folderPath.replace(/\\/g, '/')}/${this.includeGlobPattern}`, {
			ignore: this.excludeGlobPattern || undefined,
			nodir: true
		})
		
		return cssFilePaths.map(path.normalize)
	}

	private trackFile(filePath: string) {
		let item = this.map.get(filePath)
		if (!item) {
			item = {
				document: null,
				version: 0,
				opened: false,
				fresh: false,
				updatePromise: null
			}

			this.map.set(filePath, item)
			this.handleTrackFollowed(filePath, item)
		}
	}

	private handleTrackFollowed(filePath: string, item: TrackMapItem) {
		if (this.updateImmediately) {
			this.doUpdate(filePath, item)
		}
		else {
			this.allFresh = false
			console.log(`${filePath} tracked`)
			this.onTrack(filePath, item)
		}
	}

	//still keep data for ignored items 
	ignore(filePath: string) {
		this.ignoredFilePaths.add(filePath)
		console.log(`${filePath} ignored`)
	}

	notIgnore(filePath: string) {
		this.ignoredFilePaths.delete(filePath)
		console.log(`${filePath} restored from ignored`)
	}

	hasIgnored(filePath: string) {
		return this.ignoredFilePaths.has(filePath)
	}

	private reTrackFile(filePath: string) {
		let item = this.map.get(filePath)
		if (item) {
			if (item.opened) {
				//changes made in opened files, should update after been saved
				if (!item.fresh && this.updateImmediately) {
					this.doUpdate(filePath, item)
				}
			}
			else {
				item.document = null
				item.version = 0
				this.handleExpired(filePath, item)
			}
		}
		else {
			this.trackFile(filePath)
		}
	}

	private handleExpired(filePath: string, item: TrackMapItem) {
		if (!item.opened && this.updateImmediately) {
			this.doUpdate(filePath, item)
		}
		else {
			item.fresh = false
			this.allFresh = false
			console.log(`${filePath} expired`)
			this.onExpired(filePath, item)
		}
	}

	//document is always the same object for the same file
	//very frequently to trigger when do editing
	private trackOpenedFile(filePath: string, document: TextDocument) {
		let item = this.map.get(filePath)
		if (item) {
			//both newly created document and firstly opened document have version=1
			let changed = document.version > item.version
			item.document = document
			item.version = document.version
			item.opened = true

			if (changed && item.fresh) {
				this.handleExpired(filePath, item)
			}
		}
		else {
			item = {
				document,
				version: document.version,
				opened: true,
				fresh: false,
				updatePromise: null
			}

			this.map.set(filePath, item)
			this.handleTrackFollowed(filePath, item)
		}
	}

	private unTrackOpenedFile(filePath: string) {
		let item = this.map.get(filePath)
		if (item) {
			//it becomes same as not opened document, but still fresh
			item.document = null
			item.version = 1
			item.opened = false
			console.log(`${filePath} closed`)
		}
	}

	unTrackPath(deletedPath: string) {
		for (let filePath of this.map.keys()) {
			if (filePath.startsWith(deletedPath)) {
				let item = this.map.get(filePath)
				if (item) {
					this.map.delete(filePath)
					this.ignoredFilePaths.delete(filePath)
					console.log(`${filePath} removed`)
					this.onUnTrack(filePath, item)
				}
			}
		}

		//may restore ignore
		this.allFresh = false
	}

	async beFresh() {
		if (!this.allFresh) {
			timer.start('update')

			if (!this.startPathLoaded) {
				await this.loadStartPath()
			}

			let promises: Promise<boolean>[] = []
			for (let [filePath, item] of this.map.entries()) {
				if (!item.fresh) {
					promises.push(this.doUpdate(filePath, item))
				}
			}

			let updateResults = await Promise.all(promises)
			let updatedCount = updateResults.reduce((count, value) => count + (value ? 1 : 0), 0)

			if (updatedCount > 0) {
				console.log(`${updatedCount} files updated in ${timer.end('update')} milliseconds`)
			}

			this.allFresh = true
		}
	}

	private async doUpdate(filePath: string, item: TrackMapItem): Promise<boolean> {
		if (!this.ignoredFilePaths.has(filePath)) {
			item.updatePromise = item.updatePromise || this.getUpdatePromise(filePath, item)
			await item.updatePromise
			item.updatePromise = null
			return true
		}

		return false
	}

	private async getUpdatePromise(filePath: string, item: TrackMapItem) {
		let hasDocumentBefore = item.opened && !!item.document
		if (!hasDocumentBefore) {
			item.document = await this.loadDocumentFromFilePath(filePath)

			if (item.document) {
				item.version = item.document.version
			}
		}
		
		item.fresh = true
		await this.onUpdate(filePath, item)

		console.log(`${filePath} loaded from ${hasDocumentBefore ? 'document' : 'file'}`)
	}

	private async loadDocumentFromFilePath(filePath: string): Promise<TextDocument | null> {
		let languageId = path.extname(filePath).slice(1).toLowerCase()
		let uri = Uri.file(filePath).toString()
		let document = null

		try {
			let text = await readText(filePath)
			document = TextDocument.create(uri, languageId, 1, text)
		}
		catch (err) {
			console.log(err)
		}

		return document
	}

	protected onTrack(filePath: string, item: TrackMapItem) {}
	protected onExpired(filePath: string, item: TrackMapItem) {}
	protected async onUpdate(filePath: string, item: TrackMapItem) {}
	protected onUnTrack(filePath: string, item: TrackMapItem) {}
}