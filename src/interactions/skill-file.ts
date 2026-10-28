/**
 * SKILL.md(Agent Skillsの形式)の読み書き(仕様: docs/spec/behavior.md「スキル」)。
 * 冒頭の「---」で囲んだ部分(YAMLのフロントマター)から、nameとdescriptionだけを読む。ほかの項目は使わない。
 * YAMLのうち、SKILL.mdでよく使う書き方(そのままの文字、引用符で囲んだ文字、「|」「>」で始まる複数行)だけを読む。
 */

/** SKILL.mdの中身 */
export interface SkillFile {
	name: string;
	description: string;
	body: string;
}

/** ファイルの先頭に付くことがある、BOM(U+FEFF) */
const BOM = String.fromCharCode(0xfeff);
const BACKSLASH = String.fromCharCode(92);

/** ダブルクォートの中の、1文字のエスケープ */
const SIMPLE_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	b: "\b",
	f: "\f",
	'"': '"',
	"/": "/",
	" ": " ",
	[BACKSLASH]: BACKSLASH,
};

/** ダブルクォートの中の、文字コードのエスケープ(文字と、続く16進数の桁数) */
const HEX_ESCAPES: Record<string, number> = { x: 2, u: 4, U: 8 };

/** SKILL.mdを読む。冒頭のフロントマターがないか、nameかdescriptionがなければnull */
export function parseSkillFile(text: string): SkillFile | null {
	const lines = (text.startsWith(BOM) ? text.slice(1) : text)
		.replace(/\r\n?/g, "\n")
		.split("\n");
	if (lines[0]?.trimEnd() !== "---") {
		return null;
	}
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trimEnd() === "---",
	);
	if (end === -1) {
		return null;
	}
	const fields = readFields(lines.slice(1, end));
	const name = fields.get("name")?.trim() ?? "";
	const description = fields.get("description")?.trim() ?? "";
	if (name === "" || description === "") {
		return null;
	}
	return {
		name,
		description,
		body: cleanSkillBody(lines.slice(end + 1).join("\n")),
	};
}

/** 本文の、前の空行と、後ろの空白を外す(字下げは残す) */
export function cleanSkillBody(body: string): string {
	return body.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** SKILL.mdを書く。説明は、YAMLとしてそのまま書けなければ、引用符で囲む */
export function formatSkillFile(skill: SkillFile): string {
	return [
		"---",
		`name: ${yamlScalar(skill.name)}`,
		`description: ${yamlScalar(skill.description)}`,
		"---",
		"",
		skill.body,
		"",
	].join("\n");
}

/** フロントマターの、いちばん外側の項目を読む。値は文字列にする(入れ子の項目やリストの値は空にする) */
function readFields(lines: string[]): Map<string, string> {
	const fields = new Map<string, string>();
	let index = 0;
	while (index < lines.length) {
		const match = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(lines[index] ?? "");
		index++;
		if (!match) {
			// 空行、コメント、入れ子の項目、リストなど
			continue;
		}
		const { value, next } = readValue((match[2] ?? "").trim(), lines, index);
		const key = match[1] ?? "";
		if (!fields.has(key)) {
			fields.set(key, value);
		}
		index = next;
	}
	return fields;
}

/** 項目の値を読む。restは「キー:」の後ろ、startは次の行。値が続く行の、次の行も返す */
function readValue(
	rest: string,
	lines: string[],
	start: number,
): { value: string; next: number } {
	if (rest.startsWith('"') || rest.startsWith("'")) {
		return readQuoted(rest, lines, start);
	}
	const next = continuationEnd(lines, start);
	const continuation = lines.slice(start, next);
	if (/^[|>]/.test(rest)) {
		return { value: readBlock(rest.startsWith("|"), continuation), next };
	}
	const firstLine = continuation.find((line) => line.trim() !== "") ?? "";
	if (rest === "" && /^\s*(?:-(?:\s|$)|[^\s#][^:]*:(?:\s|$))/.test(firstLine)) {
		// 入れ子の項目やリスト(metadataなど)。文字列ではないので読まない
		return { value: "", next };
	}
	return {
		value: fold([withoutComment(rest), ...continuation.map(withoutComment)]),
		next,
	};
}

/** 値が続く行の、次の行。字下げした行と空行が続く間は、同じ値の続き */
function continuationEnd(lines: string[], start: number): number {
	let end = start;
	let index = start;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line.trim() !== "" && !/^\s/.test(line)) {
			break;
		}
		index++;
		if (line.trim() !== "") {
			// 最後の空行は、値に含めない
			end = index;
		}
	}
	return end;
}

/**
 * 「|」か「>」で始まる、複数行の値を読む。字下げは、最初の行に合わせて外す。
 * 「|」は改行をそのまま残し、「>」は行を空白でつなぐ(空行は改行にする)
 */
function readBlock(literal: boolean, lines: string[]): string {
	const first = lines.find((line) => line.trim() !== "") ?? "";
	const indent = first.length - first.trimStart().length;
	const unindented = lines.map((line) => line.slice(indent).trimEnd());
	return literal ? unindented.join("\n") : fold(unindented);
}

/** 引用符で囲んだ値を読む。閉じる引用符まで、次の行に続くことがある */
function readQuoted(
	rest: string,
	lines: string[],
	start: number,
): { value: string; next: number } {
	const quote = rest[0] === '"' ? '"' : "'";
	const parts: string[] = [];
	let text = rest.slice(1);
	let index = start;
	for (;;) {
		const close = closingQuote(text, quote);
		if (close !== -1) {
			parts.push(text.slice(0, close));
			break;
		}
		parts.push(text);
		if (index >= lines.length) {
			// 閉じていない。読めたところまでを使う
			break;
		}
		text = lines[index] ?? "";
		index++;
	}
	const folded = fold(parts);
	return {
		value:
			quote === '"'
				? unescapeDoubleQuoted(folded)
				: folded.replaceAll("''", "'"),
		next: index,
	};
}

/** 閉じる引用符の位置。なければ-1。ダブルクォートでは「\"」、シングルクォートでは「''」を飛ばす */
function closingQuote(text: string, quote: string): number {
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote === '"' && char === BACKSLASH) {
			index++;
		} else if (char === quote) {
			if (quote === "'" && text[index + 1] === "'") {
				index++;
			} else {
				return index;
			}
		}
	}
	return -1;
}

/** ダブルクォートの中のエスケープを、文字に戻す。知らないエスケープは、続く文字をそのまま使う */
function unescapeDoubleQuoted(text: string): string {
	let result = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char !== BACKSLASH) {
			result += char;
			continue;
		}
		const escaped = text[index + 1] ?? "";
		const digits = HEX_ESCAPES[escaped];
		if (digits !== undefined) {
			const hex = text.slice(index + 2, index + 2 + digits);
			const code = Number.parseInt(hex, 16);
			if (
				hex.length === digits &&
				/^[0-9a-fA-F]+$/.test(hex) &&
				code <= 0x10ffff
			) {
				result += String.fromCodePoint(code);
				index += 1 + digits;
				continue;
			}
		}
		result += SIMPLE_ESCAPES[escaped] ?? escaped;
		index++;
	}
	return result;
}

/** 複数行の値を、YAMLの折り返しの規則で1つにする。行の間は空白にし、空行は改行にする */
function fold(lines: string[]): string {
	let result = "";
	let blankLines = 0;
	for (const line of lines.map((part) => part.trim())) {
		if (line === "") {
			blankLines++;
			continue;
		}
		if (result !== "") {
			result += blankLines > 0 ? "\n".repeat(blankLines) : " ";
		}
		result += line;
		blankLines = 0;
	}
	return result;
}

/** 行の中の「 #」から後ろ(YAMLのコメント)を外す */
function withoutComment(line: string): string {
	const comment = line.search(/(?:^|\s)#/);
	return comment === -1 ? line : line.slice(0, comment);
}

/** YAMLの値として書く。そのままでは別の意味になる文字なら、引用符で囲む */
function yamlScalar(text: string): string {
	return isPlainSafe(text) ? text : JSON.stringify(text);
}

/** YAMLで、引用符で囲まずに書けるか */
function isPlainSafe(text: string): boolean {
	return (
		text !== "" &&
		text === text.trim() &&
		!/[\n\r\t]/.test(text) &&
		!/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
		!text.includes(": ") &&
		!text.includes(" #") &&
		!text.endsWith(":") &&
		// 数や、真偽値、空の値として読まれるもの
		!/^(?:true|false|yes|no|on|off|null|~|[-+.\d][\d._eE+-]*)$/i.test(text)
	);
}
