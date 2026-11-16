<img src="assets/icon.png" alt="Zero Assistant" width="112" align="right">

# Zero Assistant

**Your personal assistant in Telegram. Your voice assistant at home.**

Zero brings conversation, memory and useful everyday tools together. Ask a question,
send a voice message, plan your day or set a reminder—all from the same chat.
Connect Home Assistant to bring your home into the conversation and talk to Zero
through Assist.

Start with Telegram on its own. Add Google services, Home Assistant and other
connections when you want more. Each person or group gets its own permissions,
conversation and memory.

[Get started](#get-started) · [Audio transcription](docs/transcription.md) · [Home Assistant integration](https://github.com/fixtse/ha-zero-assistant) · [Technical guide](docs/technical-guide.md) · [Calorie tracking](docs/nutrition.md)

## A conversation that can do things

Zero goes beyond answering questions. With your connected services and permission,
it can check your calendar, manage tasks, create documents, find places and act on
what you ask.

- **Plan your day.** Check your agenda and availability, create or update Google
  Calendar events, and manage tasks with Google Tasks or Home Assistant to-do lists.
- **Keep useful information.** Remember preferences, ongoing plans and details you
  want to come back to later. Search earlier conversations without scrolling
  through your chat.
- **Find answers online.** Search the internet, read public pages and find images.
  Search availability depends on your selected AI provider and configured services.
- **Find somewhere to go.** Look up places and addresses, get approximate driving
  distances and journey times, and open suggestions in Google Maps.
- **Create something to share.** Create Google Docs, update existing documents and
  get PDF export links. With a supported Codex account and model, generate images
  and receive the original image files in Telegram.
- **Follow through later.** Set reminders, countdown timers and repeating reminders.
  You can also schedule an assistant request, such as a fresh search or a summary,
  to run when its reminder fires.

Try asking:

> “What does my day look like, and when am I free for a meeting?”
>
> “Remind me in 30 minutes to check the oven.”
>
> “Remember that I prefer quiet restaurants with vegetarian options.”
>
> “Find somewhere nearby for dinner and send me the map links.”
>
> “Tomorrow at nine, search for the latest news about this topic and summarize it.”

Some examples need an optional connection, location source or enabled permission.
Zero only uses the tools available to your profile.

## Send it, say it, forward it

You do not have to type everything. Send a voice message to speak to Zero, share
an image for help understanding it, or attach a document to discuss its contents.
Zero handles text, images, PDFs with a text layer, Word documents, spreadsheets,
audio and video attachments.

**Need a transcript?** Forward an audio or voice message, send a video or video
note, or reply to an audio/video message to request its transcription. Direct
voice and audio messages are treated as spoken requests; forwarded recordings
and video transcripts are returned as text rather than executed as instructions.

Transcription is optional. Leave it off, pick a Home Assistant speech-to-text
engine for each profile, or run one or more self-hosted
[ClipSE Whisper](docs/transcription.md#clipse-whisper-as-a-standalone-service)
servers—Zero load balances them and fails over automatically. Optional spoken replies
let you listen to answers; you can turn them off while keeping transcription.
Scanned PDFs currently need their pages sent as images.

## Memory that stays useful

Tell Zero something once and keep it available for future conversations. Long-term
memory can retain relevant preferences, facts and plans, while conversation search
helps recover what was actually discussed.

Choose advanced semantic memory, simple keyword-based memory or no long-term
memory for each profile. Automatic memory extraction runs separately after a
conversation; you can also explicitly ask Zero to remember something. Review,
correct, delete or set an expiration for saved memories in the admin interface.

Use `/nuevo` for a fresh conversation without losing long-term memories. Private
chats, groups and different assistants have separate histories and memory scopes.

## Telegram on its own

**Home Assistant is optional.** A standalone Zero installation can chat, search
the web, work with media, remember useful context and deliver reminders and timers
in Telegram. Connect your Google account to add calendar, tasks and documents.

Use Zero privately or add it to an approved group. In groups, mention the bot or
reply to one of its messages to bring it into the conversation. Group permissions
and shared memory are managed separately from private chats.

Create multiple assistants with their own personalities and Telegram bots. Choose
which AI models each profile can use, and switch between permitted models with
`/model`. Zero supports Codex CLI, OpenAI, Anthropic, OpenRouter,
OpenAI-compatible endpoints and Ollama. Available features depend on the provider
and model you choose.

## Bring your home into the conversation

Connect Home Assistant to let Zero answer questions about your home and help with
permitted actions. Add the unified
[Zero Assistant integration](https://github.com/fixtse/ha-zero-assistant) for Assist
conversations and event-driven home features.

### Talk to Zero through Assist

Choose **Zero** as the conversation agent in a Home Assistant Assist pipeline.
Home Assistant handles the microphone, wake word, speech recognition and spoken
reply; Zero brings its personality, memory and tools to the conversation.

Link your Home Assistant user to your Zero Telegram profile to share conversation
context, memory and permissions across voice and chat. Answers to Assist requests
return through Assist. You can also use Zero through Home Assistant without a
Telegram bot, and no physical voice satellite is required to connect the integration.

### Ask about your home and the people in it

- **Sensors and history:** check permitted readings and explore up to seven days
  of recorded sensor history.
- **Shopping and to-do lists:** check what is missing, add items and mark them done.
- **Weather:** ask about the forecast from your configured Home Assistant weather
  source, including hourly detail when available.
- **Location:** ask about permitted people, home/away status, known zones and
  approximate distances. Location-aware suggestions use available observations
  and account for their age and accuracy.
- **Home actions:** ask Zero to use the Home Assistant services explicitly allowed
  for your profile.

### Let your home tell you when something matters

Create sensor, location and weather alerts that Home Assistant evaluates when
conditions change. Ask for a notice when a reading crosses a threshold, someone
enters or leaves a zone, or a forecast changes. These features require the unified
Zero integration and the relevant permissions.

Telegram profiles have a **Weather notifications** preference: off, important weather
only, important weather plus occasional updates, or all changes. Existing owner
weather monitoring defaults to occasional updates; other profiles opt in. New rain,
storms, snow, hail, fog, strong winds and extreme temperatures bypass the routine
interval (six hours by default, configurable from 1–24 hours). Zero remembers sent
weather episodes across daily/hourly forecasts and restarts, suppresses small
revisions, and alerts again for material worsening or timing changes. Rain starting
at least an hour earlier or extending at least three hours merits another alert;
a daily alert can receive one hourly reminder within six hours of onset. Routine
updates require meaningful changes, such as a temperature shift of at least 3 °C,
a UV risk threshold crossing, or clearing hazardous weather. Minor changes remain
in the morning briefing if enabled. These preferences govern the profile's managed
weather monitoring; independently requested custom weather rules keep their own
settings. Forecasts cover the configured Home Assistant area, and the existing
owner sleep suppression is retained. Delivery history advances only after a
successful send; an uncertain send is never automatically replayed.

Optional Telegram morning briefings bring together weather, agenda and tasks.
Choose a clock time or a Home Assistant wake-up condition. Wake-up reminders can
join that briefing, so “remind me when I wake up” does not need a guessed time.
Calendar event reminders are also available when enabled.

> “Let me know if the freezer temperature stays above this limit.”
>
> “Notify me when I leave the office.”
>
> “When I wake up tomorrow, remind me to take the package.”

Clock reminders and timers run in Zero and work without Home Assistant. Sensor,
location and weather conditions run in Home Assistant. You simply describe what
you want to happen.

## Your assistant, your settings

The web admin interface brings assistants, users, connections, AI providers and
memory management together, in English or Spanish. Give each profile its own
reply language, timezone, voice settings and permitted tools.

New Telegram contacts stay pending until approved. Google and Home Assistant
connections are optional and enabled per profile. Integration credentials are
stored encrypted, and tool permissions are checked when actions run. Home
Assistant entities and other large catalogs are discovered on demand, so Zero
can look up the relevant data as the conversation needs it.

Zero is self-hosted. Your selected AI, speech, search and integration providers
process the content needed for their features; local storage does not make every
connected service local. Local-model options are available through Ollama and
compatible endpoints. You can also reuse a supported Home Assistant AI Task
provider without copying its model credentials into Zero.

Image search can use Brave, SearchAPI Google Images or SerpApi Google Images.
Configure their API keys and choose the default in **Settings → Web and image
search**. Zero can discover configured providers and select one for a search.
Google Images providers support size and transparent-background filters; returned
URLs and dimensions still need checking against the exact device model and the
original image. Search errors do not switch providers automatically.

## Get started

1. **Install Zero.** Follow the [Docker Compose instructions](docs/technical-guide.md#run)
   for a standalone service. Home Assistant users connect that service through the
   [HACS integration](https://github.com/fixtse/ha-zero-assistant). Supervisor
   [add-on source packaging](addons/zero/README.md) is also available for advanced
   setups; it is not a published add-on release.
2. **Open the web interface.** Create your administrator account. The **setup
   wizard** then asks where you will use Zero—**Telegram only**, **Home Assistant
   only** or **both**—and walks you through the AI model, your Telegram bot, the
   Home Assistant pairing and (optionally) audio transcription. You can skip any
   step and reopen the wizard later from the sidebar.
3. **Connect your first channel.** Message your bot and approve your chat in
   **Users**, or pair Home Assistant and select Zero in Assist.
4. **Make it yours.** Choose your assistant’s personality, memory mode and tools.
   Connect Google, speech services or Home Assistant features as needed.

For standalone installation, requirements, backups and administration, see the
[technical guide](docs/technical-guide.md). Developers will also find architecture,
HTTP API, tool discovery and deployment details there. Existing installations
moving to Mem0 should follow the
[offline memory migration guide](docs/mem0-migration.md).

For Home Assistant, use the single
[`assistant_zero` HACS integration](https://github.com/fixtse/ha-zero-assistant).
It brings conversation, shared settings and home alerts together in one package.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow and checks, and [SECURITY.md](SECURITY.md) to report
vulnerabilities privately.

## License

Zero Assistant is free software: you can redistribute it and/or modify it under the
terms of the [GNU Affero General Public License, version 3](LICENSE)
(`AGPL-3.0-only`).

If you modify Zero and let other people interact with it over a network (for
example, through Telegram, Home Assistant or the web interface), the AGPL requires
you to offer those users the corresponding source code of your modified version.
The admin interface links to the source code for this purpose; update that link if
you run a fork.

Zero Assistant is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the license for details.
