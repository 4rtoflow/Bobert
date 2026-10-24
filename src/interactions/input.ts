import type { APIModalSubmitInteraction } from "discord-api-types/v10";
import { ComponentType } from "../discord/constants";

/** APIキーやモデルIDに使われる文字(空白を除く、表示できるASCII文字) */
export const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** モーダルで入力された値を読む */
export function readTextInput(
	interaction: APIModalSubmitInteraction,
	customId: string,
): string | undefined {
	for (const component of interaction.data.components) {
		if (
			component.type === ComponentType.Label &&
			component.component.type === ComponentType.TextInput &&
			component.component.custom_id === customId
		) {
			return component.component.value;
		}
	}
	return undefined;
}

/**
 * 入力されたキーやIDを整える。全角の英数字は半角にし、空白と見えない文字(ゼロ幅スペースなど)は取り除く。
 * コピーしたときや、日本語入力のままで入力したときに混ざることがあるため。
 */
export function normalizeInput(input: string): string {
	return input.normalize("NFKC").replace(/[\s​-‍⁠﻿]/g, "");
}
