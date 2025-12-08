Send prompts to Google Gemini from Homey Flows and use the AI's answer in your automations.

Features
- Text Prompts: "Send Prompt" action card that accepts text prompts and returns AI-generated responses;
- Image Analysis: "Send Prompt with Image" action card that accepts multimodal prompts (image + text) and returns AI-generated responses;
- Simple settings page to store your Gemini API Key;
- Powered by Google Generative AI (gemini-2.5-flash-lite).

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
AND: Manage true/false response
```

Requirements
- A valid Google Gemini API Key (see setup guide: https://github.com/s-dimaio/com.dimapp.geminiforhomey#getting-your-google-gemini-api-key).

Setup
1) Open the app’s Settings and insert your API Key. 
2) Create a Flow and add the action “Send Prompt” or “Send Prompt with Image”.
3) Provide the prompt and use the “Gemini answer” token in subsequent Flow cards.

Privacy
- The app stores only your API Key in Homey’s settings.
- Prompts and answers are sent to Google’s API when you run the Flow.