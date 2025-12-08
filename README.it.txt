Invia prompt a Google Gemini dai Flow di Homey e usa la risposta dell'IA nelle tue automazioni.

Caratteristiche
- Prompts di testo: il Flow "Invia Prompt" accetta prompt testuali e restituisce una risposta generata dall'AI;
- Prompts multimodali: il Flow "Invia Prompt con Immagine" accetta prompt multimodali (immagine + testo) e restituisce una risposta generata dall'AI;
- Semplice pagina di impostazioni per salvare la tua chiave API Gemini;
- Basato su Google Generative AI (gemini-2.5-flash-lite).

Esempi di utilizzo
```
WHEN: Movimento rilevato nel soggiorno
THEN: Invia Prompt "Genera un messaggio di benvenuto per chi entra nel soggiorno"
AND: Pronuncia la risposta di Gemini
```
```
WHEN: Cambiamento delle condizioni meteo
THEN: Invia Prompt "Crea un breve avviso meteo basato sulle previsioni di oggi"
AND: Invia una notifica con la risposta di Gemini
```
```
WHEN: La videocamera del citofono rileva movimento
THEN: Invia Prompt con Immagine "Descrivi cosa vedi in questa immagine e identifica eventuali persone o pacchi"
AND: Invia una notifica con l'analisi di Gemini
```
```
WHEN: Il sensore di sicurezza si attiva
THEN: Scatta uno snapshot con la telecamera
AND: Invia Prompt con Immagine "Analizza questa immagine della telecamera di sicurezza e descrivi eventuali minacce"
AND: Registra il risultato dell'analisi
```
```
WHEN: Movimento rilevato nel magazzino
THEN: Cattura un'immagine dalla telecamera di sicurezza
AND: Invia Prompt con Immagine "Controlla se qualcosa appare spostato o fuori posto in quest'area. Rispondi 'true' se tutto è OK, altrimenti rispondi 'false'"
AND: Gestisci la risposta true/false
```

Requisiti
- Una chiave API Google Gemini valida (vedi guida alla configurazione: https://github.com/s-dimaio/com.dimapp.geminiforhomey#getting-your-google-gemini-api-key).

Configurazione
1) Apri le Impostazioni dell'app ed inserisci la tua chiave API.
2) Crea un Flow e aggiungi l'azione “Invia Prompt” o “Invia Prompt con Immagine”.
3) Fornisci il prompt e usa il token “Risposta di Gemini” nelle schede Flow successive.

Privacy
- L'app memorizza solo la tua chiave API nelle impostazioni di Homey.
- I prompt e le risposte vengono inviati all'API di Google quando esegui il Flow.