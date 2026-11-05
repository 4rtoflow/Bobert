import type { JevAnswer, JevResponse } from "./api";
import { jevHeading, noulLine, scoreLine } from "./texts";
import type { DisplayQuestion } from "./tool";

/**
 * Jevの答えを、投稿する本文にする(仕様: docs/spec/behavior.md「スラッシュコマンド」の右クリックメニュー)。
 * 質問ごとに、見出し(AIが書いた質問)と、確率を書く。質問の間は1行空ける
 */
export function formatJevAnswers(
	questions: readonly DisplayQuestion[],
	response: JevResponse,
): string {
	return questions
		.flatMap((question) => {
			const answer = response.answers[question.name];
			return answer === undefined ? [] : [formatAnswer(question, answer)];
		})
		.join("\n\n");
}

function formatAnswer(question: DisplayQuestion, answer: JevAnswer): string {
	const heading = jevHeading(displayText(question.label));
	switch (answer.type) {
		case "noul":
			return [heading, noulLine(percent(answer.noul))].join("\n");
		case "choice":
			return [heading, ...choiceLines(question, answer.probabilities)].join(
				"\n",
			);
		case "score":
			return [
				heading,
				scoreLine(
					answer.score.toFixed(1),
					Math.max(question.levels.length - 1, 0),
				),
				...scoreLevelLines(question, answer.probabilities),
			].join("\n");
	}
}

/** 選択肢を、確率の高い順に並べる(同じなら、AIが書いた順)。いちばん高いものを太字にする */
function choiceLines(
	question: DisplayQuestion,
	probabilities: Record<string, number>,
): string[] {
	return question.options
		.map((option, position) => ({
			label: option.label,
			probability: probabilities[option.name] ?? 0,
			position,
		}))
		.sort((a, b) => b.probability - a.probability || a.position - b.position)
		.map((option, rank) => {
			const line = `${displayText(option.label)} ${percent(option.probability)}%`;
			return rank === 0 ? `- **${line}**` : `- ${line}`;
		});
}

/** 段階を、低い順に、番号を付けて並べる。確率のいちばん高い段階(同じなら低い方)を太字にする */
function scoreLevelLines(
	question: DisplayQuestion,
	probabilities: Record<string, number>,
): string[] {
	const levels = question.levels.map((label, index) => ({
		label,
		index,
		probability: probabilities[String(index)] ?? 0,
	}));
	const best = levels.reduce<(typeof levels)[number] | undefined>(
		(top, level) =>
			top === undefined || level.probability > top.probability ? level : top,
		undefined,
	);
	return levels.map((level) => {
		const line = `${level.index} ${displayText(level.label)} ${percent(level.probability)}%`;
		return level.index === best?.index ? `- **${line}**` : `- ${line}`;
	});
}

/** 確率(0〜1)を、整数のパーセントにする */
function percent(probability: number): number {
	return Math.round(probability * 100);
}

/**
 * AIが書いた、表示する文。改行は空白にし(行の形を崩さないため)、
 * DiscordのMarkdownの記号は、そのまま表示されるようにする(太字などの形を崩さないため)
 */
function displayText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\\*_~`|]/g, "\\$&");
}
