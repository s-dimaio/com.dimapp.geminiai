Send prompts to Google Gemini from Homey Flows and use the AI's answer in your automations. If used together with a Telegram account you can create custom bots for managing your home.

Features
- Text Prompts: "Send Prompt" action card that accepts text prompts and returns AI-generated responses.
- Multimodal Prompts: "Send Prompt with Image" action card that accepts an image plus text and returns AI-generated analysis.
- Home Automation Commands: "Execute a command for your smart home" action card that sends natural language commands to Gemini to control Homey devices.
- Scheduled Automations: Create automations by asking Gemini to run a command at a certain time. Manage timers in the app settings.
- Model Selection: Choose your preferred Gemini model (Flash, Pro, Gemini 3) in the settings.
- Simple settings page to store your Gemini API Key and select models.
- Powered by Google Generative AI (user-selectable models).

Usage Examples
```
WHEN: A Telegram message with smart home comand is received (ie swithc off all lights)
THEN: Send prompt to Gemini AI with Telegram message
AND: Send a Telegram message with Gemini reply
```
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
WHEN: It is the weekend 
THEN: Send an "Ask question" notification with the text: "The weekend is almost here. What would you like me to do?" 
AND: Send a Prompt with the user response: "Start heating the house tomorrow at 6:00 PM" 
AND: Process the response and verify successful execution
```

Requirements
- A valid Google Gemini API Key (see setup guide: https://github.com/s-dimaio/com.dimapp.geminiforhomey#getting-your-google-gemini-api-key).

Setup
1) Open the app’s Settings and insert your API Key.
2) Select the Gemini Model you want to use.
3) Create a Flow and add the action “Send Prompt”, “Send Prompt with Image” or “Execute a command for your smart home”.
4) Provide the prompt and use the returned tokens (e.g., `Gemini answer`, `response`, `success`) in subsequent Flow cards.

Privacy
- The app stores only your API Key in Homey’s settings.
- Prompts and answers are sent to Google’s API when you run the Flow.