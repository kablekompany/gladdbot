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
import { ChatClient } from "@twurple/chat";
import { COMMAND_COOLDOWN, MAX_OUTPUT_LENGTH, MODERATORS, REGULARS } from "./consts";

// #region AI
const rawInstructions = await fs.readFile("./instructions.txt", "utf-8");

const systemInstruction = rawInstructions
	.replace("{{MAX_OUTPUT_LENGTH}}", `${MAX_OUTPUT_LENGTH}`)
	.replace("{{MODERATORS}}", MODERATORS)
	.replace("{{REGULARS}}", REGULARS);

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
		temperature: 0.6,
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
			'${data.accessToken}',
			'${data.refreshToken}',
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
const client = new ChatClient({ authProvider: auth, channels: ["Gladd", "xiBread_"] });
client.connect();

console.log(`${gray("[SYSTEM]")} Connected`);

let rateLimitMessageSent = false;
let globalTimestamp = Number.NaN;

client.onMessage(async (channel, user, text, msg) => {
	if (!text.trim().startsWith("!ask")) return;

	const now = Date.now();
	const username = yellow(msg.userInfo.displayName);
	const expiration = globalTimestamp + COMMAND_COOLDOWN;

	if (now < expiration) {
		const timestamp = green(new Date(now).toLocaleString("en-US"));
		const remaining = ((expiration - now) / 60 / 60).toFixed(1);

		return console.log(
			`${yellow("[COOLDOWN]")} ${username} - ${timestamp} (${remaining} seconds left)`,
		);
	}

	const question = text.slice(4).trim();
	if (!question) return;

	console.log(`${cyan("[QUESTION]")} ${username}: ${question}`);

	try {
		const { response } = await model.generateContent(question);
		const truncated = truncate(response.text());

		if (!truncated) {
			console.log(`${gray("[SYSTEM]")} Message failed to generate. Ratings:`);
			console.log(formatRatings(response.candidates![0].safetyRatings!));
		} else {
			rateLimitMessageSent = false;

			console.log(`${cyan("[ANSWER]")} ${truncated}`);
			client.say(channel, truncated, { replyTo: msg });
		}

		globalTimestamp = now;
		setTimeout(() => (globalTimestamp = Number.NaN), COMMAND_COOLDOWN);
	} catch (error) {
		if (!(error instanceof GoogleGenerativeAIError)) return;

		if (error.message.includes("429") && !rateLimitMessageSent) {
			client.say(
				channel,
				"Slow down there partner! I can only answer so many questions at once, try again later.",
			);

			rateLimitMessageSent = true;
		}

		console.log(red(error.message));
	}
});

/**
 * Helper to truncate text because AI likes to ignore the max output length.
 * This also makes sure that the response ends with a full sentence instead
 * of stopping mid-sentence.
 */
function truncate(text: string, length = MAX_OUTPUT_LENGTH) {
	text = text.trim().replace(/\n/g, " ");

	let truncated = "";

	for (const word of text.split(" ")) {
		if (truncated.length + word.length + 1 > length) break;
		truncated += `${word} `;
	}

	truncated = truncated.trim();
	if (/[.?!]$/.test(truncated)) return truncated;

	return truncated
		.split(/(\.|\?|!)/)
		.slice(0, -1)
		.join("");
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
		`  - Dangerous content: ${getProbability("DANGER")}`,
		`  - Harassment: ${getProbability("HARASS")}`,
		`  - Hate speech: ${getProbability("HATE")}`,
		`  - Sexually explicit: ${getProbability("SEXUAL")}`,
	].join("\n");
}
// #endregion
