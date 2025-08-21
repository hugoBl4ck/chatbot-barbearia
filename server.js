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
    // Extrai os parâmetros do Dialogflow
    const dateTime = request.body.queryResult.parameters["date-time"];
    const personName = request.body.queryResult.outputContexts[0].parameters["person.original"] || "Cliente";

    try {
      // Salva na planilha e formata a data
      const formattedDate = await saveToSheet(personName, dateTime);
      responseText = `Perfeito, ${personName}! Seu agendamento foi confirmado e salvo para ${formattedDate}.`;
    } catch (error) {
      console.error("Erro ao salvar na planilha:", error);
      responseText = "Houve um erro ao tentar salvar seu agendamento. Por favor, tente novamente.";
    }
  }

  // Envia a resposta de volta ao Dialogflow
  response.json({ fulfillmentText: responseText });
});


// --- FUNÇÃO PARA SALVAR NA PLANILHA ---
async function saveToSheet(name, dateTime) {
  // Carrega as credenciais do ambiente do Render
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const sheetId = process.env.SHEET_ID;

  // Inicializa a conexão com a planilha usando o ID
  const doc = new GoogleSpreadsheet(sheetId);
  
  // Autentica usando a conta de serviço
  await doc.useServiceAccountAuth(creds);
  
  // Carrega as informações da planilha
  await doc.loadInfo(); 
  
  // Seleciona a primeira aba (worksheet) da planilha
  const sheet = doc.sheetsByIndex[0];
  
  // Formata a data para um formato amigável ANTES de salvar
  const dateObj = new Date(dateTime);
  const options = {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
  };
  const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', options).format(dateObj);

  // Adiciona uma nova linha com os dados
  await sheet.addRow({
    NomeCliente: name,
    DataHoraAgendamento: formattedDateForUser, // Salva a data já formatada
    Status: 'Confirmado'
  });
  
  // Retorna a data formatada para ser usada na resposta ao usuário
  return formattedDateForUser;
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
