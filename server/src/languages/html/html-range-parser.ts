import {Range} from 'vscode-languageserver'
import {TextDocument} from 'vscode-languageserver-textdocument'
import {SimpleSelector} from '../common/simple-selector'


export interface HTMLNamedRange {
	name: string
	range: Range
}


export class HTMLRangeParser {

	protected document: TextDocument

	constructor(document: TextDocument) {
		this.document = document
	}

	/** Parse HTML document to ranges. */
	parse(): HTMLNamedRange[] {
		let text = this.document.getText()
		let ranges: HTMLNamedRange[] = []

		let re = /(?:<!--.*?-->|<\w+(.*?)>)/gs
		/*
			\s* - match white spaces in left
			(?:
				<!--.*?--> - match html comment
				|
				<\w+(.+?)> - match tag, $1 is the arrtibutes
			)
		*/

		let match: RegExpExecArray | null

		while (match = re.exec(text)) {
			let attribute = match[1]
			if (!attribute) {
				continue
			}

			let startIndex = match.index
			let endIndex = re.lastIndex

			ranges.push(...this.getRangesFromAttribute(attribute, startIndex, endIndex))
		}
		
		return ranges
	}

	/** Parse CSS range for HTML tag attribute. */
	protected getRangesFromAttribute(attribute: string, start: number, end: number): HTMLNamedRange[] {
		let re = /\b(class|id)\s*=\s*(?:"(.*?)"|'(.*?)')/g
		let match: RegExpExecArray | null
		let ranges: HTMLNamedRange[] = []

		while (match = re.exec(attribute)) {
			let attr = match[1].trim()
			let value = match[2] || match[3]

			if (!value) {
				continue
			}

			if (attr === 'class') {
				for (let name of value.split(/\s+/)) {
					name = '.' + name

					if (SimpleSelector.validate(name)) {
						ranges.push({
							name,
							range: Range.create(this.document.positionAt(start), this.document.positionAt(end))
						})
					}
				}
			}
			else {
				let name = '#' + value

				if (SimpleSelector.validate(name)) {
					ranges.push({
						name,
						range: Range.create(this.document.positionAt(start), this.document.positionAt(end))
					})
				}
			}
		}

		return ranges
	}
}
