// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const sheetId = process.env.SHEET_ID;
const doc = new GoogleSpreadsheet(sheetId);

// Função principal do webhook
app.post("/webhook", async (request, response) => {
  const intent = request.body.queryResult.intent.displayName;
  let responsePayload = {
    fulfillmentMessages: [{ text: { text: ["Desculpe, não entendi o que você quis dizer."] } }]
  };

  if (intent === "AgendamentoHorario") { // Renomeei a intent para melhor clareza
    const dateTime = request.body.queryResult.parameters["date-time"].date_time;
    const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
    
    try {
      const resultMessage = await handleScheduling(personName, dateTime);
      responsePayload = createResponse(resultMessage);
    } catch (error) {
      console.error("Erro no fluxo de agendamento:", error);
      responsePayload = createResponse("Houve um erro interno ao tentar agendar. Por favor, tente mais tarde.");
    }
  }

  response.json(responsePayload);
});

// --- FUNÇÕES AUXILIARES ---

// Extrai o nome do cliente do contexto
function getPersonName(contexts) {
  if (!contexts || contexts.length === 0) return null;
  const contextWithName = contexts.find(ctx => ctx.parameters && ctx.parameters["person.original"]);
  return contextWithName ? contextWithName.parameters["person.original"] : null;
}

// Cria o objeto de resposta para o Dialogflow
function createResponse(text) {
  return {
    fulfillmentMessages: [{ text: { text: [text] } }]
  };
}

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO ---
async function handleScheduling(name, requestedDateTime) {
  if (!requestedDateTime) {
    return "Por favor, informe uma data e hora para o agendamento.";
  }

  // Autentica e carrega a planilha
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  // Define as abas
  const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia']; // Renomeei a aba para ser mais explícita
  const configSheet = doc.sheetsByTitle['Horarios'];

  // Converte a data solicitada para um formato de trabalho
  const requestedDate = new Date(requestedDateTime);
  if (isNaN(requestedDate.getTime())) {
    return "A data e hora que você informou não são válidas. Por favor, tente novamente.";
  }

  // 1. VERIFICAR SE O HORÁRIO DE FUNCIONAMENTO É VÁLIDO
  const dayOfWeek = requestedDate.getDay(); // Domingo=0, Segunda=1...
  const requestedTime = requestedDate.getHours() + requestedDate.getMinutes() / 60;

  const configRows = await configSheet.getRows();
  const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

  if (!dayConfig || (!dayConfig.InicioManha && !dayConfig.InicioTarde)) {
    return "Desculpe, não funcionamos neste dia. Por favor, escolha outro dia.";
  }

  const isMorningShift = requestedTime >= parseFloat(dayConfig.InicioManha.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimManha.replace(':', '.'));
  const isAfternoonShift = dayConfig.InicioTarde && requestedTime >= parseFloat(dayConfig.InicioTarde.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimTarde.replace(':', '.'));

  if (!isMorningShift && !isAfternoonShift) {
    return "Desculpe, estamos fechados neste horário. Nosso horário de funcionamento é ..."; // Você pode melhorar esta mensagem
  }

  // 2. VERIFICAR SE O HORÁRIO JÁ ESTÁ OCUPADO
  const existingAppointments = await scheduleSheet.getRows();
  const isSlotTaken = existingAppointments.some(appointment => {
    const appointmentDate = new Date(appointment.DataHoraAgendamento);
    // Verifica se há um agendamento no mesmo dia e hora
    return appointmentDate.getTime() === requestedDate.getTime();
  });

  if (isSlotTaken) {
    return "Desculpe, este horário já está ocupado. Por favor, escolha outro horário.";
  }
  
  // 3. SE TUDO ESTIVER OK, SALVAR O AGENDAMENTO
  const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Sao_Paulo'
  }).format(requestedDate);

  await scheduleSheet.addRow({
    NomeCliente: name,
    DataHoraAgendamento: requestedDate.toISOString(), // Salva em formato universal
    Status: 'Confirmado'
  });
  
  return `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.`;
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
