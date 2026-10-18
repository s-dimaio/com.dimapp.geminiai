# Gemini AI for Homey Pro

**Chat directly with Gemini AI using the Homey Dashboard Widget, or integrate it into your Flows as an advanced, autonomous smart home assistant.**

This Homey app bridges your smart home with Google's Generative AI models (`@google/genai`), allowing you to interact with your home using natural language. Use the Dashboard Widget to chat with Gemini, query device states, control capabilities, or schedule future actions. Additionally, integrate Gemini into your Flows to evaluate complex yes/no conditions, analyze camera snapshots, manage Standard and Advanced Flows, or automate device routines.

---

## 🌟 Key Features

- **Dashboard Chat Widget**: Interactive chat widget on your Homey dashboard to control devices, query real-time states, and execute automations. Built with an asynchronous polling queue to prevent UI timeouts.
- **Smart Home Assistant (MCP Engine)**: Autonomous function calling powered by the Model Context Protocol (MCP). Gemini discovers resources, queries device status, and executes actions across your smart home.
- **Multi-Role Model Routing**: Dedicated model assignment for each operational role:
  - **Conversational AI (`chat`)**: Fast, lightweight models (e.g. `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`) for general questions, condition cards, and vision analysis.
  - **Basic Smart Home (`shGeneric`)**: High-efficiency model for querying and controlling smart home devices (defaults to `gemini-3.8-flash`).
  - **Automation & Flows (`shFlow`)**: Advanced reasoning model specialized in designing, creating, and modifying Homey Standard and Advanced Flows (defaults to `gemini-3.8-flash`, with support up to `gemini-4-argon`).
  - **Image Generation (`image`)**: Model dedicated to generating images (`gemini-3.1-flash-image`).
- **Google Gemini Interactions API & Native Context Caching**: Fully migrated to Google's next-generation `interactions.create` API. Static system instructions and MCP tool schemas (~20,000 tokens) are cached directly in Google GenAI server-side memory, reducing latency and prompt token costs by up to 88% across multi-turn sessions.
- **Standard & Advanced Flow Management**: Natural language creation, modification, connection, deletion, and rollback restoration of both Standard and visual DAG Advanced Flows, complete with automatic spatial auto-layout computation.
- **Intelligent Structured Condition Cards**: Three boolean condition cards (`Ask Gemini`, `Ask Gemini with Image`, `Ask Gemini using Smart Home`) backed by native JSON schemas with multi-language guardrails that reliably evaluate polar conditions while cleanly rejecting open-ended questions.
- **Real-time Token Usage Logging**: Detailed logging of input tokens, output tokens, thinking tokens, and cached tokens on every request for complete operational transparency.
- **Sensor History & Device Logs**: Query past sensor trends, averages, and historical time-series data (temperature, energy consumption, etc.).
- **Matter OTA Firmware Management**: Check firmware availability for all devices and trigger over-the-air updates for Matter devices.
- **Multi-Turn Memory & Pruning**: Remembers conversational context across interactions via server-side session tracking (`previous_interaction_id`) with automatic idle timeout cleanup.
- **Scheduled Automations**: Schedule commands with natural language (e.g., *"Turn off living room lights at 11 PM"* or *"in 15 minutes"*), persisted across app restarts with trigger card activation.
- **Custom Instructions & AI Prompt Generator**: Write natural rules (e.g., *"Always check the bedroom Daikin when I ask for temperature"*) and convert them automatically into formatted Markdown system prompts.
- **Hidden & Grouped Devices Control**: Configurable access to devices marked as hidden or grouped in Homey.

---

## 📋 Requirements

- **Homey Pro** with firmware `>= 12.4.0` (Homey Apps SDK v3).
- **Google Gemini API Key**: Obtainable from [Google AI Studio](https://aistudio.google.com/). A Pay-As-You-Go plan is recommended to unlock Context Caching and high token-per-minute (TPM) limits.
- **HomeyScript App**: Required to grant flow-triggering permissions (`homey.flow.start`) on Homey Pro.

---

## 🚀 Installation & Local Setup

### From Homey App Store
1. Open the Homey app on your phone or web browser.
2. Navigate to **More** → **Apps**.
3. Search for **Gemini AI** and install it.

### Development & Local Build
1. Clone this repository:
   ```bash
   git clone https://github.com/s-dimaio/com.dimapp.geminiai.git
   cd com.dimapp.geminiai
   ```
2. Install development dependencies:
   ```bash
   npm install
   ```
3. Use the build and debug scripts:
   - **Build production bundle**: `npm run build` (uses `@vercel/ncc` to compile `app.src.js` $\rightarrow$ `dist/index.js`)
   - **Run in debug mode**: `npm run debug` (builds and runs with live logs)
   - **Install on target Homey**: `npm run install`
   - **Publish update**: `npm run publish`

---

## 🔑 Google Gemini API Key Configuration

### 1. Get an API Key
1. Visit [Google AI Studio](https://aistudio.google.com/).
2. Sign in with your Google account.
3. Click **Get API Key** in the sidebar and create a key in a Google Cloud project.
4. *(Recommended)* Under **Plan & Billing**, link a billing account to activate Pay-As-You-Go for Context Caching and high rate limits.

### 2. Configure Homey Settings
1. In Homey, go to **More** → **Apps** → **Gemini AI** → **Settings**.
2. Paste your **API Key**.
3. Choose your preferred models for **Conversational AI**, **Smart Home Management**, and **Automation Management**.
4. *(Optional)* Add Custom Instructions or toggle Google Search Grounding / Hidden Devices.
5. Click **Save**.

---

## 💡 Flow Cards Reference

### 🎬 Action Cards

1. **Send a prompt (`send-prompt`)**
   - *Description*: Sends a plain text prompt to the Conversational AI model.
   - *Tokens returned*: `answer` (AI response text).
2. **Send a prompt with image (`send-prompt-with-image`)**
   - *Description*: Multimodal analysis combining an image token (camera snapshot/webcam) with a text prompt.
   - *Tokens returned*: `answer` (analysis text), `analyzed_image` (captured image buffer).
3. **Execute Smart Home MCP Command (`send-mcp-command`)**
   - *Description*: Executes natural language smart home commands using MCP function calling.
   - *Tokens returned*: `response` (text answer), `success` (boolean), `timer_id` (schedule ID if a timer was set).
4. **Seed Conversation Context (`seed-conversation-context`)**
   - *Description*: Pre-injects a contextual message into Gemini's multi-turn conversation memory before a subsequent MCP command runs.

### ❓ Condition Cards

1. **Evaluate Prompt (`evaluate-prompt`)**
   - *Description*: Evaluates a yes/no question using general AI reasoning. Returns `true` if Gemini answers YES.
2. **Evaluate Prompt with Image (`evaluate-prompt-with-image`)**
   - *Description*: Evaluates a yes/no question about an image token (e.g., *"Is there a package on the porch?"*).
3. **Evaluate Smart Home Command (`evaluate-mcp-command`)**
   - *Description*: Evaluates a yes/no question by querying real-time smart home device states (e.g., *"Is any light on in the garden?"*).

### ⚡ Trigger Cards

1. **Gemini Response Ready (`gemini_response_ready`)**
   - *Description*: Triggers asynchronously when a text prompt finishes processing.
   - *Tokens*: `response` (text).
2. **Gemini Image Response Ready (`gemini_image_response_ready`)**
   - *Description*: Triggers asynchronously when an image prompt finishes processing.
   - *Tokens*: `response` (text), `image` (Homey Image).
3. **Scheduled Command Executed (`scheduled_command_executed`)**
   - *Description*: Triggers when a scheduled command timer is executed by the scheduler.
   - *Tokens*: `timer_id`, `command`, `success`, `response`.

---

## 🛠️ MCP Tools & Capabilities (Smart Home Engine)

When executing smart home requests, Gemini autonomously selects from 15 canonical tools:

| MCP Tool | Description |
| :--- | :--- |
| `control_device` | Changes device capabilities (`onoff`, `dim`, `target_temperature`, `volume_set`, `windowcoverings_state`, etc.). |
| `get_device_state` | Queries real-time device capability values and availability status with error reason extraction. |
| `discover_resources` | Discovers devices, user-installed apps, or system managers with query, zone, and class filtering. |
| `get_home_summary` | Summary of device counts, status by class/zone (e.g. lights on, doors locked), and offline device list. |
| `manage_schedule` | Creates, lists, or cancels future command timers (`create`, `list`, `cancel`). |
| `discover_flows` | Discovers and filters existing Standard and Advanced Flows by name, folder, type, or state. |
| `discover_flow_details` | Inspects the internal node structure, triggers, conditions, and action arguments of a Flow. |
| `manage_flow` | Creates, updates, deletes, or restores Standard Homey Flows (with 2-hour backup protection). |
| `manage_advanced_flow` | Designs, connects, updates, deletes, or restores Advanced Flows with automatic DAG layout computation. |
| `discover_flow_cards` | Lists available action, trigger, or condition cards for a specific device, app, or system manager. |
| `run_action_card` | Executes device-specific action cards with arguments and returns output tokens / images. |
| `get_device_image` | Retrieves the current image or webcam snapshot from a camera device. |
| `get_device_logs` | Fetches historical data, averages, and time-series sensor trends across configurable resolutions. |
| `manage_device_firmware` | Scans for available firmware updates across all devices and installs OTA updates on Matter nodes. |
| `trigger_flow` | Triggers a Homey Flow by name via the HomeyScript execution proxy. |

---

## 📦 Technical Stack & Architecture

- **AI SDK**: `@google/genai` (^2.30.0 - Google Gemini Interactions API)
- **Homey API**: `homey-api` (^3.20.1 - Local API v3)
- **Compiler**: `@vercel/ncc` (v0.38.4)
- **Runtime**: Homey Pro Apps SDK v3 (Node.js)

```
com.dimapp.geminiai/
├── app.src.js            # Main application source entrypoint
├── dist/index.js         # Compiled bundle created by ncc
├── lib/
│   ├── GeminiClient.js   # GenAI orchestrator, caching, conversation memory, tool calling loop
│   ├── HomeyMCPAdapter.js# Bridge between Gemini function declarations and Homey Local API
│   ├── ModelConfig.js    # Model routing definitions, deprecation fallbacks, settings migration
│   ├── Scheduler.js      # Short (<24h) and long (>=24h) timer engine with settings persistence
│   ├── SystemInstruction.js # Dynamic ISO date/time, timezone, and locale context injector
│   ├── ToolSchema.js     # Function declaration schemas for Gemini tools
│   └── managers/         # Domain managers: DeviceManager, DiscoveryManager, FlowManager
├── settings/             # Settings SPA view (index.html)
└── widgets/gemini_chat/  # Dashboard Chat Widget (non-blocking task queue)
```

---

## 🔒 Privacy & Security

- **Local Execution**: Smart home device discovery and execution are performed directly on your local Homey Pro via `HomeyAPIV3Local`.
- **API Key Storage**: Stored securely in Homey's encrypted persistent settings store.
- **Data Transmission**: Prompts, images, and tool responses are transmitted directly and securely to Google Gemini APIs via TLS.

---

## 📄 License & Support

- **Author**: Simone Di Maio
- **Repository**: [com.dimapp.geminiai](https://github.com/s-dimaio/com.dimapp.geminiai)
- **Issues & Feedback**: [GitHub Issues](https://github.com/s-dimaio/com.dimapp.geminiai/issues)
- **License**: GNU General Public License v3.0 (GPL-3.0)
