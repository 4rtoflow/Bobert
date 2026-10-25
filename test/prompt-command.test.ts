import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
	TextInputStyle,
} from "../src/discord/constants";
import { MAX_PROMPT_LENGTH } from "../src/interactions/prompt";
import { getUserSettings, updateUserSettings } from "../src/store/users";
import { guildInteraction, sendInteraction, userFactory } from "./helpers";

/** 新しいユーザー(テストごとに別の人にする)。/promptは、キーを登録していなくても使える */
const newUser = userFactory(700);

function promptCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "14", name: "prompt", type: 1 },
		user,
	);
}

/** モーダルで、valueを入力して送信する */
function submit(user: APIUser, value: string) {
	return guildInteraction(
		InteractionType.ModalSubmit,
		{
			custom_id: "prompt:edit",
			components: [
				{
					type: ComponentType.Label,
					id: 1,
					component: {
						type: ComponentType.TextInput,
						id: 2,
						custom_id: "prompt",
						value,
					},
				},
			],
		},
		user,
	);
}

describe("/prompt", () => {
	it("指示を編集するモーダルを開く。複数行で、1500文字まで入力できる", async () => {
		const user = await newUser();

		const body = await sendInteraction(promptCommand(user));

		expect(body.type).toBe(InteractionResponseType.Modal);
		expect(body.data.custom_id).toBe("prompt:edit");
		const input = body.data.components[0].component;
		expect(input).toMatchObject({
			custom_id: "prompt",
			style: TextInputStyle.Paragraph,
			required: false,
			max_length: MAX_PROMPT_LENGTH,
		});
		expect(MAX_PROMPT_LENGTH).toBe(1500);
		// 指示をまだ設定していなければ、入力欄は空
		expect(input.value).toBeUndefined();
	});

	it("今の指示を入れた状態で開く", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, { customPrompt: "敬語で答えて" });

		const body = await sendInteraction(promptCommand(user));

		expect(body.data.components[0].component.value).toBe("敬語で答えて");
	});

	it("送信された指示を保存し、結果を本人にだけ見せる。前後の空白は除く", async () => {
		const user = await newUser();

		const body = await sendInteraction(
			submit(user, "  箇条書きで答えて\n専門用語には説明を付けて  "),
		);

		expect(body).toEqual({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: {
				flags: MessageFlags.Ephemeral,
				content: "自分用の指示を保存しました。次の返答から使います。",
			},
		});
		expect((await getUserSettings(env.DB, user.id)).customPrompt).toBe(
			"箇条書きで答えて\n専門用語には説明を付けて",
		);
	});

	it("空にして送信したら、指示なしに戻す", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, { customPrompt: "敬語で答えて" });

		const body = await sendInteraction(submit(user, "  \n "));

		expect(body.data).toEqual({
			flags: MessageFlags.Ephemeral,
			content:
				"自分用の指示を消しました。次の返答から、共通の指示だけで答えます。",
		});
		expect((await getUserSettings(env.DB, user.id)).customPrompt).toBeNull();
	});

	it("ほかの設定は変えない", async () => {
		const user = await newUser();
		await updateUserSettings(env.DB, user.id, {
			modelKey: "gpt-6-luna",
			effort: "high",
		});

		await sendInteraction(submit(user, "敬語で答えて"));

		expect(await getUserSettings(env.DB, user.id)).toMatchObject({
			modelKey: "gpt-6-luna",
			effort: "high",
			customPrompt: "敬語で答えて",
		});
	});
});
