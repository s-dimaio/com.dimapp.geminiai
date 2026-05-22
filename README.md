# Gemini AI

**Chat directly with Gemini AI using the Homey Dashboard Widget, or integrate it into your Flows as a powerful smart home assistant.**

This Homey app bridges the gap between your smart home and advanced artificial intelligence, allowing you to interact with your home using natural language. Use the Dashboard Widget to chat directly with Gemini to ask about your home's status, control devices without rigid commands, or naturally schedule tasks. Additionally, integrate Gemini into your existing Flows to analyze images, process text, or generate intelligent responses.

## Features

- **Dashboard Chat Widget**: Chat directly with Gemini AI from your Homey interface to control devices, query status, or schedule tasks naturally.
- **Smart Home Assistant**: Gemini acts as an intelligent assistant within your existing Flows. It can control devices, query the state of your home, and trigger your existing automations.
- **Text Prompts**: "Send a prompt" action card that accepts text and returns AI-generated responses for custom automations.
- **Image Analysis**: "Send a prompt with image" action card for multimodal prompts (image + text). Perfect for security camera analysis.
- **Custom Instructions**: Define specific rules or context that Gemini must always follow when interpreting smart home commands.
- **Conversation Context**: "Set conversation context" action card to inject context for follow-up commands across flows.
- **Scheduled Automations**: Schedule commands to run in the future (e.g., "Turn off the lights in 10 minutes").
- **Retry Logic**: Intelligent quota limit handling (429 errors) with automatic retries.
- **Model Selection**: Choose between Gemini models (Flash, Pro, Gemini 3) in settings to balance speed and performance.
- **Token Support**: Returns various tokens (answer, success, timer ID) usable in subsequent Flow cards.
- **Image Integration**: Full support for Homey image tokens (e.g., webcam snapshots).

## Requirements

- Homey Pro with firmware >=12.4.0
- Google Gemini API Key (free plan available)
- **HomeyScript**: Required for triggering Flows and executing advanced actions on devices.

## Installation

### From Homey App Store
1. Open the Homey app on your device
2. Go to "More" → "Apps"
3. Search for "Gemini for Homey"
4. Install the app

### For Development
1. Clone this repository
2. Install dependencies: `npm install`
3. Use Homey CLI to run: `homey app run`

## Google Gemini API Key Configuration

### Step 1: Access Google AI Studio
1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Log in with your Google account

### Step 2: Create an API Key
1. Click on "Get API Key" in the sidebar
2. Click "Create API key in new project"
3. Your key will be generated automatically

### Pricing Information
- Google Gemini API offers a generous free plan (up to 15 requests per minute).
- For up-to-date details, visit [Google AI Pricing](https://ai.google.dev/pricing).

## App Configuration

1. Open Homey App → "More" → "Apps" → "Gemini for Homey" → "Settings".
2. Enter your API Key.
3. Select your preferred Gemini Model.
4. Click "Save".

## Usage Examples

### Direct Chat via Dashboard Widget
Simply add the Gemini Chat widget to your Homey dashboard to instantly ask questions like "Did I leave any windows open?" or give commands like "Start the vacuum cleaner when I leave."


### Conversational Device Control
```
WHEN: Voice command received
THEN: Run a command for your smart home "Turn off all lights in the living room"
AND: Speak the response
```

### Image Analysis with Webcam
```
WHEN: Doorbell detects motion
THEN: Send a prompt with image "Describe what you see in this image and identify people or packages"
AND: Send notification with Gemini's analysis
```

### Smart Home Query
```
WHEN: Schedule triggered
THEN: Run a command for your smart home "Which lights are on in the kitchen?"
AND: Log the response
```

### Contextual Follow-up
```
WHEN: Motion detected at front door
THEN: Set conversation context "Do you want me to turn on the entrance light?"
AND: Wait for voice command

WHEN: Voice command received ("yes, turn it on")
THEN: Run a command for your smart home with the voice text
```

## Technical Details

### Main Dependencies
- `@google/genai`: Official Google Generative AI SDK (v1.46.0+)
- `homey-api`: Homey API Client (v3.17.3+)
- `homey`: Homey Apps SDK v3

### Flow Cards (Actions)

#### Send a prompt (Text Only)
- **Input**: Text prompt
- **Output**: `answer` token with Gemini's response

#### Send a prompt with image (Multimodal)
- **Input**: Image token + Text prompt
- **Output**: `answer` token with Gemini's response

#### Run a command for your smart home (Function Calling)
This action uses the Model Context Protocol (MCP) to interact with Homey. Gemini autonomously decides which tools to use from the 16 available:

**Main Tools:**
- `control_device`: Controls any device (on/off, brightness, temperature, etc.).
- `trigger_flow`: Triggers a Homey Flow by name.
- `get_device_state`: Queries the current state of a device.
- `list_devices_in_zone`: Lists devices in a specific zone/room.
- `get_devices_status_by_class`: Status of all devices of a class (e.g., "which lights are on?").
- `search_devices`: Advanced (fuzzy) search for devices by keywords.
- `schedule_command`: Schedules future command execution.
- `list_flows` / `get_flow_info`: Discovery and details of existing automations.
- `list_device_actions` / `run_action_card`: Execution of specific (Action Cards) non-standard actions.

**Technical Notes:**
- Requires `homey:manager:api` permission.
- Works only on local Homey installations (not Homey Cloud).

## Privacy and Security

- **API Key Storage**: Securely stored in Homey settings.
- **Data Processing**: Prompts, images, and responses are processed by Google Gemini APIs.
- **No Local Retention**: The app does not store prompts or generated analyses.

## Troubleshooting

**"HomeyScript app is NOT installed"**
- Install the HomeyScript app from the official store to enable Flow triggering and device actions.

**"Quota exceeded" (429)**
- Gemini Client implements an automatic retry system, but if the error persists, check your plan limits on Google AI Studio.

## Support
- **Issues**: [GitHub Issues](https://github.com/s-dimaio/com.dimapp.geminiai/issues)
- **Documentation**: [Gemini API Docs](https://ai.google.dev/gemini-api/docs)

---
**Author**: Simone Di Maio
**License**: GNU General Public License v3.0
