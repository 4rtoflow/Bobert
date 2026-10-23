import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/respond/split";

describe("長い返答の分割", () => {
	it("上限以内なら分けない", () => {
		expect(splitMessage("こんにちは")).toEqual(["こんにちは"]);
	});

	it("段落の切れ目で分け、収まる分はまとめる", () => {
		const paragraph = (char: string) => char.repeat(900);
		const text = [paragraph("a"), paragraph("b"), paragraph("c")].join("\n\n");
		expect(splitMessage(text)).toEqual([
			`${paragraph("a")}\n\n${paragraph("b")}`,
			paragraph("c"),
		]);
	});

	it("コードブロックの途中で分けるときは、閉じてから次で開き直す", () => {
		const lines = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`);
		const text = `説明\n\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
		const chunks = splitMessage(text);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
			// どのメッセージでも、コードブロックの開始と終了が対になっている
			expect(chunk.match(/```/g)?.length ?? 0).toBe(2);
		}
		expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
		// 分けた行を戻すと、元のコードになる
		const code = chunks
			.flatMap((chunk) => chunk.split("\n"))
			.filter((line) => line.startsWith("const "));
		expect(code).toEqual(lines);
	});

	it("空白のない長い1行は、上限の位置で切る", () => {
		const text = "あ".repeat(4500);
		const chunks = splitMessage(text);
		expect(chunks.map((chunk) => chunk.length)).toEqual([2000, 2000, 500]);
		expect(chunks.join("")).toBe(text);
	});

	it("絵文字(サロゲートペア)の途中では切らない", () => {
		const text = "😀".repeat(1500);
		const chunks = splitMessage(text);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
			expect(chunk).toMatch(/^(😀)+$/u);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("空白のある長い1行は、空白の位置で切る", () => {
		const words = Array.from({ length: 600 }, (_, i) => `word${i}`);
		const chunks = splitMessage(words.join(" "));
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
		expect(chunks.flatMap((chunk) => chunk.split(" "))).toEqual(words);
	});
});
