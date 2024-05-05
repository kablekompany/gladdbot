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

const MAX_OUTPUT_LENGTH = 400;

// #region AI
const rawInstructions = await fs.readFile("./data/instructions.txt", "utf-8");

const moderatorList = await fs.readFile("./data/moderators.txt", "utf-8");
const regularsList = await fs.readFile("./data/regulars.txt", "utf-8");
const emoteList = await fs.readFile("./data/emotes.txt", "utf-8");

const systemInstruction = rawInstructions
	.replace("{{MODERATORS}}", moderatorList.replace(/\n/g, ", "))
	.replace("{{REGULARS}}", regularsList.replace(/\n/g, ", "))
	.replace("{{EMOTES}}", emoteList.replace(/\n/g, ", "));

if (systemInstruction.length > 8192) {
	throw new RangeError(
		red(`System instruction length exceeds 8192 characters (${systemInstruction.length}).`),
	);
}

console.log(
	`${gray("[SYSTEM]")} System instructions loaded (${yellow(systemInstruction.length)} characters)`,
);

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
		// {
		// 	category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
		// 	threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE
		// }
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

const [data] = await sql<[TokenData]>`SELECT * FROM tokens`;

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
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresIn: data.expires_in,
		obtainmentTimestamp: data.obtainment_timestamp,
		scope: ["chat:edit", "chat:read"],
	},
	["chat"],
);
// #endregion

// #region Logic
const bot = new Bot({
	authProvider: auth,
	channels: ["Gladd", "xiBread_"],
	commands: [
		createBotCommand("ask", exec, {
			aliases: ["ai"],
			globalCooldown: 15,
			userCooldown: 30,
		}),
	],
});

bot.onConnect(() => console.log(`${gray("[SYSTEM]")} Connected to Twitch`));

async function exec(params: string[], { reply, userDisplayName: user }: BotCommandContext) {
	const question = params.join(" ");
	if (!question) return;

	console.log(`${cyan("[QUESTION]")} ${yellow(user)}: ${question}`);

	try {
		const { response } = await model.generateContent(`${user} asked ${question}`);

		const rawText = response.text();
		const sanitized = sanitize(rawText);

		if (!sanitized) {
			console.log(`${gray("[SYSTEM]")} Message failed to send.`);
			console.log(`  Raw text: ${rawText}`);
			console.log(`  Ratings:`);
			console.log(formatRatings(response.candidates![0].safetyRatings!));
		} else {
			console.log(`${cyan("[ANSWER]")}`);
			console.log(`  Raw text: ${rawText}`);
			console.log(`  Sanitized: ${sanitized}`);

			await reply(sanitized);
		}
	} catch (error) {
		// TODO: handle errors better
		if (!(error instanceof GoogleGenerativeAIError)) return;

		console.error(red(error.message));
	}
}
// #endregion

// #region Util
const emoteRegex = new RegExp(
	`(${emoteList
		.split("\n")
		.map((line) => line.split(" ")[0])
		.join("|")})([.,!?])`,
	"g",
);

// Using \p{Emoji} matches numbers as well, hence the unicode ranges
// https://stackoverflow.com/a/41543705
const emojiRegex =
	/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g;

function sanitize(text: string, limit = MAX_OUTPUT_LENGTH) {
	return (
		text
			/**
			 * Yes, naively slicing will possibly cut off text mid-sentence; however,
			 * there's no good method to detect the end of a sentence when using 7TV
			 * emotes.
			 */
			.slice(0, limit)
			// insert zws at the beginning of commands
			.replace(/^([!/])/, "\u200B$1")
			// newlines to spaces
			.replace(/\n/g, " ")
			// remove escapes
			.replace(/\\(.)/g, "$1")
			.replace(emojiRegex, "")
			.replace(emoteRegex, "$1 $2")
	);
}

const probabilityColors = {
	[HarmProbability.HARM_PROBABILITY_UNSPECIFIED]: gray,
	[HarmProbability.NEGLIGIBLE]: cyan,
	[HarmProbability.LOW]: green,
	[HarmProbability.MEDIUM]: yellow,
	[HarmProbability.HIGH]: red,
};

function formatRatings(ratings: SafetyRating[]) {
	function getProbability(keyword: string) {
		const { probability: p } = ratings.find((r) => r.category.includes(keyword))!;
		return probabilityColors[p](p);
	}

	return [
		`    - Dangerous content: ${getProbability("DANGER")}`,
		`    - Harassment: ${getProbability("HARASS")}`,
		`    - Hate speech: ${getProbability("HATE")}`,
		`    - Sexually explicit: ${getProbability("SEXUAL")}`,
	].join("\n");
}
// #endregion
