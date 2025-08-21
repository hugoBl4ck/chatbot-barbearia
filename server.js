// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// Função principal do webhook
app.post("/webhook", async (request, response) => {
  const intent = request.body.queryResult.intent.displayName;
  let responseText = "Desculpe, não entendi o que você quis dizer.";

  if (intent === "AgendarHorario") {
    const dateTime = request.body.queryResult.parameters["date-time"];
    
    let personName = "Cliente";
    const outputContexts = request.body.queryResult.outputContexts;
    if (outputContexts && outputContexts.length > 0) {
      const contextWithName = outputContexts.find(ctx => ctx.parameters && ctx.parameters["person.original"]);
      if (contextWithName) {
        personName = contextWithName.parameters["person.original"];
      }
    }

    try {
      const formattedDate = await saveToSheet(personName, dateTime);
      responseText = `Perfeito, ${personName}! Seu agendamento foi confirmado e salvo para ${formattedDate}.`;
    } catch (error) {
      console.error("Erro ao salvar na planilha:", error);
      responseText = "Houve um erro ao tentar salvar seu agendamento. Por favor, tente novamente.";
    }
  }

  response.json({ fulfillmentText: responseText });
});


// --- FUNÇÃO PARA SALVAR NA PLANILHA (VERSÃO DE DEPURAÇÃO) ---
async function saveToSheet(name, dateTime) {
  // ***** PASSO DE DEPURAÇÃO: Imprime o valor recebido nos logs *****
  console.log("Valor de 'dateTime' recebido do Dialogflow:", JSON.stringify(dateTime, null, 2));

  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const sheetId = process.env.SHEET_ID;

  const doc = new GoogleSpreadsheet(sheetId);
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
  
  const sheet = doc.sheetsByIndex[0];

  const dateString = (typeof dateTime === 'object' && dateTime.start) ? dateTime.start : dateTime;
  
  if (!dateString) {
      throw new Error("O valor de 'date-time' recebido do Dialogflow está vazio.");
  }

  const dateObj = new Date(dateString);
  
  if (isNaN(dateObj.getTime())) {
    throw new Error(`O valor '${dateString}' não pôde ser convertido para uma data válida.`);
  }
  
  const options = {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
  };
  const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', options).format(dateObj);

  await sheet.addRow({
    NomeCliente: name,
    DataHoraAgendamento: formattedDateForUser,
    Status: 'Confirmado'
  });
  
  return formattedDateForUser;
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
