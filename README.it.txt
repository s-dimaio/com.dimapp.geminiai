Invia prompt a Google Gemini dai Flow di Homey e usa la risposta dell'IA nelle tue automazioni. Se usato insieme ad un account Telegram puoi creare dei bot personalizzati per la gestione della tua casa.

Caratteristiche
- Prompt di testo: invia domande o istruzioni e ricevi risposte generate dall'intelligenza artificiale.
- Prompt con immagini: analizza immagini (es. da telecamere) per descrivere cosa succede in casa.
- Controllo Casa Intelligente: usa il linguaggio naturale per controllare dispositivi, chiedere lo stato della casa o attivare Flow.
- Automazioni pianificate: chiedi a Gemini di eseguire un comando a un orario specifico. I timer sono gestibili dalle impostazioni dell'app.
- Selezione del modello: scegli tra i modelli Gemini più recenti (Flash, Pro, Gemini 3) per velocità o intelligenza superiori.

Esempi di utilizzo
```
WHEN: Arriva un messaggio Telegram con un comando per la Smart Home (ie spegni tutte le luci)
THEN: Invia prompt a Gemini AI con il messaggio Telegram
AND: Invia messaggio Telegram con la risposta di Gemini
```
```
WHEN: Movimento rilevato nel soggiorno
THEN: Invia Prompt "Genera un messaggio di benvenuto per chi entra nel soggiorno"
AND: Pronuncia la risposta di Gemini
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
```
WHEN: E' arrivato il week-end
THEN: Invia una notifica "Ask question" con testo "Sta per arrivare il week-end. Cosa vuoi che faccia?"
AND: Invia Prompt con la risposta dell'utente: "Domani alle 18.00 inizia a riscaldare casa"
AND: Gestisci la risposta e verificane la corretta esecuzione
```

Requisiti
- Una chiave API Google Gemini valida (segui le istruzioni all'interno dell'app).
- L'app HomeyScript installata (opzionale: serve per permettere a Gemini di eseguire le action card dei Flow).

Configurazione
1) Apri le Impostazioni dell'app ed inserisci la tua chiave API.
2) Seleziona il modello Gemini che desideri utilizzare.
3) Crea un Flow e aggiungi l'azione “Invia Prompt”, “Invia Prompt con Immagine” o “Esegui un comando per la tua smart home”.
4) Fornisci il prompt e usa i token “Risposta di Gemini”, “Risposta” o “Successo” nelle schede Flow successive.

Privacy
- L'app memorizza solo la tua chiave API nelle impostazioni di Homey.
- I prompt e le risposte vengono inviati all'API di Google quando esegui il Flow.