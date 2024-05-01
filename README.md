# GladdBot

Curated Twitch chatbot for [Gladd](https://twitch.tv/gladd).

## Running

### Prerequisites

You'll need 2-3 things:

1. A Google AI API Key
2. A service Twitch account
3. A database (optional)

#### API Key

Go to [aistudio.google.com](https://aistudio.google.com/app/apikey), click `Get API Key` on the left, and follow the instructions from there. Store the API key in the `.env` file.

#### Twitch Account

> [!WARNING]
> I would recommended you use a separate Twitch account to run this; however, if you *do* want to user yours, then the steps are the same.

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console) and create a new application
   1. Use whatever name
   2. Use `https://twitchtokengenerator.com` for the redirect url
   3. Select `Chat Bot` for the category
   4. Select `Confidential` for the client type
   5. Paste the client ID and client secret into the `.env` file
2. Create a new Twitch account
3. Go to [twitchtokengenerator.com](https://twitchtokengenerator.com/), select `Bot Chat Token`, and fill in the Client Secret and Client ID fields. Store the access token and refresh token somewhere temporary.

To get the user ID of the account you just created, replace `REPLACE_ME` in the following command with the account name and run it in your terminal:

```sh
curl -X POST \
  -H "Client-ID: kd1unb4b3q4t58fwlpcbzcbnm76a8fp" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"query{user(login:\\\"REPLACE_ME\\\"){id}}\"}" \
  https://gql.twitch.tv/gql
```

<details>
<summary>If you have <a href="https://httpie.io/">HTTPie</a> installed, you can use this instead</summary>

```sh
http POST https://gql.twitch.tv/gql Client-ID:kd1unb4b3q4t58fwlpcbzcbnm76a8fp query="{user(login:\"REPLACE_ME\"){id}}"
```

</details>

Store this in the `.env` file.

#### Database

There are two ways to store token data: locally in a JSON file or a database. If you choose a JSON file, the file needs to look like this:

```json
{
  "accessToken": "",
  "refreshToken": "",
  "scopes": ["chat:edit", "chat:read"],
  "expiresIn": 0,
  "obtainmentTimestamp": 0
}
```

You'll need to read from this file and supply the data to `auth.addUser` and write to it in the `auth.onRefresh` event.

If you want a more secure option, you can use a database, which is what this project uses. Your table should look similar to this (example uses PostgreSQL):

```sql
CREATE TABLE tokens (
  id SERIAL CONSTRAINT PRIMARY KEY,
  access_token VARCHAR(100),
  refresh_token VARCHAR(100),
  expires_in INT,
  obtainment_timestamp BIGINT
);
```

Once you have either of these options set up, fill in the access token and refresh token that you saved earlier.

### Customizing

In order to customize the bot's personality and responses, edit the [`instructions.txt`](./data/instructions.txt) file to your liking. It's better to provide more information in order to get more curated responses. You can use the current file as a reference.
