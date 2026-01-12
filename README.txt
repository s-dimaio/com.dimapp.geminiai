Send prompts to Google Gemini from Homey Flows and use the AI's answer in your automations.

Features
- Text Prompts: "Send Prompt" action card that accepts text prompts and returns AI-generated responses.
- Multimodal Prompts: "Send Prompt with Image" action card that accepts an image plus text and returns AI-generated analysis of the image.
- Home Automation Commands: "Send Prompt with Command" action card that sends natural language commands to Gemini to control Homey devices (e.g., turn lights on/off, trigger flows).
- Simple settings page to store your Gemini API Key.
- Powered by Google Generative AI (`gemini-2.5-flash-lite`).

Usage Examples
```
WHEN: Motion is detected in the living room
THEN: Send Prompt "Generate a welcoming message for someone entering the living room"
AND: Speak the Gemini answer
```
```
WHEN: Weather changes
THEN: Send Prompt "Create a brief weather advisory based on today's forecast"
AND: Send notification with Gemini answer
```
```
WHEN: Doorbell camera detects motion
THEN: Send Prompt with Image "Describe what you see in this image and identify any people or packages"
AND: Send notification with Gemini analysis
```
```
WHEN: Security sensor triggers
THEN: Take a snapshot with camera
AND: Send Prompt with Image "Analyze this security camera image and describe any potential threats"
AND: Log the analysis result
```
```
WHEN: Motion detected in storage room
THEN: Capture image from security camera
AND: Send Prompt with Image "Check if anything appears disturbed or out of place in this storage area. Reply with 'true' if everything is OK, otherwise reply with 'false'"
AND: Manage true/false response in flows
```
```
WHEN: It's the weekend
THEN: Send Prompt with Command "Start heating the house to 20°C"
AND: Use the `success` boolean token to confirm execution and notify the user
```

Requirements
- A valid Google Gemini API Key (see setup guide: https://github.com/s-dimaio/com.dimapp.geminiforhomey#getting-your-google-gemini-api-key).

Setup
1) Open the app’s Settings and insert your API Key.
2) Create a Flow and add the action “Send Prompt”, “Send Prompt with Image” or “Send Prompt with Command”.
3) Provide the prompt and use the returned tokens (e.g., `Gemini answer`, `success`) in subsequent Flow cards.

Privacy
- The app stores only your API Key in Homey’s settings.
- Prompts and answers are sent to Google’s API when you run the Flow.