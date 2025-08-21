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
    
    // Tenta extrair o nome do contexto. Se não encontrar, usa "Cliente" como padrão.
    let personName = "Cliente";
    const outputContexts = request.body.queryResult.outputContexts;
    if (outputContexts && outputContexts.length > 0) {
      // Procura o contexto que contém o parâmetro 'person.original'
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


// --- FUNÇÃO PARA SALVAR NA PLANILHA ---
async function saveToSheet(name, dateTime) {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const sheetId = process.env.SHEET_ID;

  const doc = new GoogleSpreadsheet(sheetId);
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
  
  const sheet = doc.sheetsByIndex[0];

  // ***** A CORREÇÃO ESTÁ AQUI *****
  // Verifica se 'dateTime' é um objeto com a propriedade 'start'. Se for, usa o valor de 'start'.
  // Se não, usa o próprio 'dateTime' (que deve ser uma string).
  const dateString = (typeof dateTime === 'object' && dateTime.start) ? dateTime.start : dateTime;
  
  // Usa a 'dateString' corrigida para criar o objeto de Data.
  const dateObj = new Date(dateString);
  
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
