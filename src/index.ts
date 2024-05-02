import fs from "node:fs/promises";
import process from "node:process";
import { cyan, gray, green, red, yellow } from "kleur/colors";
import postgres from "postgres";
import {
	GoogleGenerativeAI,
	GoogleGenerativeAIError,
	HarmBlockThreshold,
	HarmCategory,
	HarmProbability,
	type SafetyRating,
} from "@google/generative-ai";
import { RefreshingAuthProvider } from "@twurple/auth";
import { Bot, type BotCommandContext, createBotCommand } from "@twurple/easy-bot";

const MAX_OUTPUT_LENGTH = 495;

// #region AI
const rawInstructions = await fs.readFile("./data/instructions.txt", "utf-8");

const moderatorList = await fs.readFile("./data/moderators.txt", "utf-8");
const regularsList = await fs.readFile("./data/regulars.txt", "utf-8");
const emoteList = await fs.readFile("./data/emotes.txt", "utf-8");

const systemInstruction = rawInstructions
	.replace("{{MAX_OUTPUT_LENGTH}}", `${MAX_OUTPUT_LENGTH}`)
	.replace("{{MODERATORS}}", moderatorList.replace(/\n/g, ", "))
	.replace("{{REGULARS}}", regularsList.replace(/\n/g, ", "))
	.replace("{{EMOTES}}", emoteList.replace(/\n/g, ", "));

if (systemInstruction.length > 8192) {
	throw new RangeError(red("System instruction length exceeds 8192 characters."));
}

const ai = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY!);
const model = ai.getGenerativeModel({
	model: "gemini-1.5-pro-latest",
	systemInstruction,
	// These filter Gemini's response, not the user's messages
	safetySettings: [
		{
			category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_HARASSMENT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
	],
	generationConfig: {
		maxOutputTokens: MAX_OUTPUT_LENGTH,
	},
});
// #endregion

// #region Auth
const sql = postgres(process.env.DATABASE_URL!);

interface TokenData {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	obtainment_timestamp: number;
}

const [
	{
		access_token: accessToken,
		refresh_token: refreshToken,
		expires_in: expiresIn,
		obtainment_timestamp: obtainmentTimestamp,
	},
] = await sql<[TokenData]>`SELECT * FROM tokens`;

const auth = new RefreshingAuthProvider({
	clientId: process.env.TWITCH_CLIENT_ID!,
	clientSecret: process.env.TWITCH_CLIENT_SECRET!,
});

auth.onRefresh(async (_, data) => {
	await sql`
		INSERT INTO tokens (
			access_token,
			refresh_token,
			expires_in,
			obtainment_timestamp
		) VALUES (
			${data.accessToken},
			${data.refreshToken},
			${data.expiresIn},
			${data.obtainmentTimestamp}
		);
	`;
});

auth.addUser(
	process.env.TWITCH_USER_ID!,
	{
		accessToken,
		refreshToken,
		expiresIn,
		obtainmentTimestamp,
		scope: ["chat:edit", "chat:read"],
	},
	["chat"],
);
// #endregion

// #region Logic
const bot = new Bot({
	authProvider: auth,
	channels: ["Gladd", "xiBread_"],
	commands: [createBotCommand("ask", exec, { aliases: ["ai"], globalCooldown: 10 })],
});

bot.onConnect(() => console.log(`${gray("[SYSTEM]")} Connected`));

async function exec(params: string[], { reply, userDisplayName }: BotCommandContext) {
	const question = params.join(" ");
	if (!question) return;

	console.log(`${cyan("[QUESTION]")} ${yellow(userDisplayName)}: ${question}`);

	try {
		const { response } = await model.generateContent(`${userDisplayName} asked ${question}`);
		const truncated = sanitize(response.text());

		if (!truncated) {
			console.log(`${gray("[SYSTEM]")} Message failed to send.`);
			console.log(`  Raw text: ${response.text()}`);
			console.log(`  Ratings:`);
			console.log(formatRatings(response.candidates![0].safetyRatings!));
		} else {
			console.log(`${cyan("[ANSWER]")} ${truncated}`);
			await reply(truncated);
		}
	} catch (error) {
		// TODO: handle errors better
		if (!(error instanceof GoogleGenerativeAIError)) return;

		console.log(red(error.message));
	}
}

const emojiRegex = new RegExp(
	`(${emoteList
		.split("\n")
		.map((line) => line.split(" ")[0])
		.join("|")})([.,!?])`,
	"g",
);

/**
 * Ensures text stays under the limit, removes emojis, new lines, and
 * markdown escapes, and adds a space between 7TV emotes and punctuation.
 *
 * Yes, naively slicing will possibly cut off text mid-sentence; however,
 * there's no good method to detect the end of a sentence when using 7TV
 * emotes.
 */
function sanitize(text: string, limit = MAX_OUTPUT_LENGTH) {
	return text
		.slice(0, limit)
		.replace(/\n/g, " ")
		.replace(/\\_/g, "_")
		.replace(/\p{Emoji}/gu, "")
		.replace(emojiRegex, "$1 $2");
}

const probabilityColors: Record<HarmProbability, (input: string) => string> = {
	[HarmProbability.HARM_PROBABILITY_UNSPECIFIED]: gray,
	[HarmProbability.NEGLIGIBLE]: cyan,
	[HarmProbability.LOW]: green,
	[HarmProbability.MEDIUM]: yellow,
	[HarmProbability.HIGH]: red,
};

function formatRatings(ratings: SafetyRating[]) {
	function getProbability(keyword: string) {
		const { probability } = ratings.find((rating) => rating.category.includes(keyword))!;
		return probabilityColors[probability](probability);
	}

	return [
		`    - Dangerous content: ${getProbability("DANGER")}`,
		`    - Harassment: ${getProbability("HARASS")}`,
		`    - Hate speech: ${getProbability("HATE")}`,
		`    - Sexually explicit: ${getProbability("SEXUAL")}`,
	].join("\n");
}
// #endregion
