# Gemini AI

**Send prompts to Google Gemini from Homey Flows and use the AI's answer in your automations.**

This Homey app integrates Google's Gemini AI into your smart home ecosystem, allowing you to create intelligent automations powered by generative AI. Send text-only or multimodal prompts (text + image) to Gemini directly from Homey Flows, or use conversational commands to control your entire smart home with natural language.

## Features

- **Text Prompts**: "Send Prompt" action card that accepts text prompts and returns AI-generated responses
- **Image Analysis**: "Send Prompt with Image" action card that accepts multimodal prompts (image + text) and returns AI-generated responses
- **Function Calling**: "Execute a command for your smart home" action card for conversational smart home control - ask Gemini to control devices, trigger flows, and query device states using natural language
- **Scheduled Automations**: Schedule commands to be executed later (e.g., "In 10 minutes turn off the lights"). Manage active timers directly in the app settings.
- **Model Selection**: Choose your preferred Gemini model (Flash, Pro, Gemini 3) in the app settings to balance speed and performance.
- **Token Support**: Returns various tokens (answer, response, success, timer_id) that can be used in subsequent Flow cards
- **Image Token Handling**: Full integration with Homey image tokens from flow triggers (e.g., webcam snapshots)
- **API Key Management**: Simple settings interface to securely store your Google Gemini API key

## Requirements

- Homey Pro with firmware >=12.4.0
- Google Gemini API key (free tier available)

## Installation

### From Homey App Store
1. Open the Homey app on your mobile device
2. Go to "More" → "Apps"
3. Search for "Gemini for Homey"
4. Install the app

### For Development
1. Clone this repository
2. Install dependencies: `npm install`
3. Use the Homey CLI to run: `homey app run --r`

## Getting Your Google Gemini API Key

### Step 1: Access Google AI Studio
1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Sign in with your Google account

### Step 2: Create an API Key
1. Click on "Get API Key" in the left sidebar
2. Click "Create API key in new project" (or select an existing project)
3. Your API key will be generated automatically


### Step 3: (Optional) Configure Usage Limits
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to "APIs & Services" → "Credentials"
3. Find your API key and click on it to set usage restrictions and quotas

### Pricing Information
- Google Gemini API offers a generous free tier
- Free tier includes up to 15 requests per minute
- For current pricing details, visit [Google AI Pricing](https://ai.google.dev/pricing)

## Setup

### 1. Configure API Key
1. After installing the app, open the Homey app
2. Go to "More" → "Apps" → "Gemini for Homey"
3. Click "Settings"
4. Enter your Google Gemini API key
5. Select your preferred Gemini Model (e.g., Gemini 1.5 Flash, Gemini 2.0 Pro, etc.)
6. Click "Save"

### 2. Create a Flow
1. Open the Homey app and go to "Flows"
2. Create a new Flow or edit an existing one
3. Add the "Send Prompt" or "Send Prompt with Image" action card from the "Gemini for Homey" app
4. Enter your prompt text (and optionally drag an image token)
5. Use the "Gemini answer" token in subsequent Flow cards

## Usage Examples

### Basic Text Prompt
```
WHEN: Motion is detected in the living room
THEN: Send Prompt "Generate a welcoming message for someone entering the living room"
AND: Speak the Gemini answer
```

### Image Analysis with Webcam
```
WHEN: Doorbell camera detects motion
THEN: Send Prompt with Image "Describe what you see in this image and identify any people or packages"
AND: Send notification with Gemini analysis
```

### Security Alert with Image
```
WHEN: Security sensor triggers
THEN: Take a snapshot with camera
AND: Send Prompt with Image "Analyze this security camera image and describe any potential threats"
AND: Log the analysis result
```

### Visual Inspection
```
WHEN: Motion detected in storage room
THEN: Capture image from security camera
AND: Send Prompt with Image "Check if anything appears disturbed or out of place in this storage area. Reply with 'true' if everything is OK, otherwise reply with 'false'"
AND: Manage true/false response
```

### Weather Advisory
```
WHEN: Weather changes
THEN: Send Prompt "Create a brief weather advisory based on today's forecast"
AND: Send notification with Gemini answer
```

### Conversational Device Control
```
WHEN: Voice command received
THEN: Execute a command for your smart home "Turn off all the lights in the living room"
AND: Speak the response
```

### Smart Home Queries
```
WHEN: Schedule triggers
THEN: Execute a command for your smart home "How many lights are currently on in the house?"
AND: Log the response
```

### Complex Automation
```
WHEN: Motion detected
THEN: Execute a command for your smart home "Set the bedroom lights to 50% brightness and turn on the bedroom fan"
AND: Send notification with response
```

### Scene Management
```
WHEN: Button pressed
THEN: Execute a command for your smart home "Activate the 'Movie Night' flow"
AND: Speak confirmation (response)
```

## Technical Details

### Project Structure
```
├── app.js                      # Main app logic and Flow action registration
├── app.json                    # App manifest (generated from .homeycompose)
├── package.json                # Node.js dependencies
├── lib/
│   └── GeminiClient.js         # Google Gemini API client
├── settings/
│   └── index.html              # API key configuration interface
├── .homeycompose/
│   ├── app.json                # App configuration source
│   └── flow/
│       └── actions/
│           ├── send-prompt.json
│           └── send-prompt-with-image.json
└── assets/                     # App icons and images
```

### Dependencies
- `@google/generative-ai`: Official Google Generative AI SDK (v1.38.0+)
- `homey-api`: Homey API client for device access (v3.2.1+)
- `homey`: Homey Apps SDK v3

### Flow Action Details

#### Send Prompt (Text Only)
- **ID**: `send-prompt`
- **Input**: Text prompt (string)
- **Output**: `answer` token (string) containing Gemini's response
- **Model**: User selected (Default: Gemini 2.5 Flash-Lite)

#### Send Prompt with Image (Multimodal)
- **ID**: `send-prompt-with-image`
- **Input**: Image token (from flow droptoken) + text prompt (string)
- **Output**: `answer` token (string) containing Gemini's response
- **Model**: User selected (Default: Gemini 2.5 Flash-Lite)
- **Limitations**: Currently supports single image per prompt

#### Execute a command for your smart home (Function Calling)
- **ID**: `send-mcp-command`
- **Input**: Natural language command (string)
- **Output**: 
  - `response` token (string) containing Gemini's natural language response
  - `success` token (boolean) whether the command was successful
  - `timer_id` token (string) ID of the created timer (if applicable)
- **Model**: User selected (Optimized for function calling)
- **Capabilities**:
  - **Device Control**: Turn devices on/off, adjust brightness/temperature, control any device capability
  - **Flow Triggering**: Start Homey Flows by name
  - **State Queries**: Check device status, list devices by zone, count devices
  - **Smart Analysis**: Gemini intelligently determines which devices and actions to execute
- **Available Functions**:
  - `control_device`: Control any Homey device (lights, thermostats, switches, etc.)
  - `trigger_flow`: Start a Homey Flow by name
  - `get_device_state`: Query current state of a device
  - `list_devices_in_zone`: List all devices in a specific room/zone
  - `list_all_devices`: Get overview of all devices in the home
- **Requirements**: 
  - Requires `homey:manager:api` permission for full device access
  - Only works on local Homey installations (not Homey Cloud)
- **Model Options**: 
  - Gemini 2.5 Flash-Lite
  - Gemini 2.5 Flash
  - Gemini 2.5 Pro
  - Gemini 3 Flash Preview
  - Gemini 3 Pro Preview

## Development

### Prerequisites
- Node.js (v16 or higher)
- Homey CLI: `npm install -g homey`

### Local Development
```bash
# Clone the repository
git clone https://github.com/s-dimaio/com.dimapp.geminiai.git
cd com.dimapp.geminiai

# Install dependencies
npm install

# Run the app in development mode
homey app run --r

# Validate the app
homey app validate

# Build for production
homey app build
```

### Testing
1. Install the app on your development Homey
2. Configure your API key in the app settings
3. Create test Flows with the "Send Prompt" and "Send Prompt with Image" actions
4. Monitor logs using `homey app run --r`

## Privacy & Security

- **API Key Storage**: Your Google Gemini API key is stored securely in Homey's settings
- **Data Processing**: Prompts, images, and responses are processed by Google's Gemini API
- **No Data Retention**: This app doesn't store or log your prompts, images, or AI responses
- **Local Processing**: The app runs on your Homey device; only API calls are sent to Google
- **Image Handling**: Images are converted to base64 and sent directly to the Gemini API; they are not stored locally

## Troubleshooting

### Common Issues

**"API key not configured" error**
- Ensure you've entered your API key in the app settings
- Verify the API key is correct and hasn't expired

**"Error sending prompt" in Flow**
- Check your internet connection
- Verify your API key has sufficient quota
- Ensure the prompt text is not empty

**"No image provided" error**
- Ensure you've dragged an image token to the "Send Prompt with Image" action card
- Verify the image token is from a compatible source (e.g., security camera, webcam)

**Empty or "none" responses**
- Check Google AI Studio for API usage limits
- Verify your API key has the necessary permissions
- Try with a simpler prompt
- For image analysis, ensure the image is clear and relevant to your prompt

**"Quota exceeded" error in MCP Command**
- Free tier allows 15 requests per minute and 1500 per day
- Quota resets every 24 hours at UTC midnight
- Consider upgrading to paid tier for higher limits
- See [Google AI Pricing](https://ai.google.dev/pricing) for details

**MCP Command not controlling devices**
- Ensure you're using a local Homey (not Homey Cloud)
- Verify device names match exactly (case-insensitive)
- Check device capabilities are supported
- Use simpler commands like "Turn on kitchen light" first

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Commit your changes: `git commit -am 'Add new feature'`
5. Push to the branch: `git push origin feature-name`
6. Create a Pull Request

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Author

**Simone Di Maio**  
Email: simone.dimaio77@gmail.com

## Support

- **Issues**: Report bugs and feature requests on [GitHub Issues](https://github.com/s-dimaio/com.dimapp.geminiai/issues)
- **Documentation**: Visit [Gemini API Docs](https://ai.google.dev/gemini-api/docs)


