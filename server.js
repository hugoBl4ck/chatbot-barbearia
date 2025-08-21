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
  let responsePayload = createResponse("Desculpe, não entendi o que você quis dizer.");

  // O nome da intent foi ajustado para corresponder ao que está no Dialogflow
  if (intent === "AgendarHorario") {
    // ***** MUDANÇA PRINCIPAL AQUI *****
    // Recebe 'data' e 'hora' separadamente
    const dateParam = request.body.queryResult.parameters.data;
    const timeParam = request.body.queryResult.parameters.hora;
    
    const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
    
    try {
      // Passa os dois novos parâmetros para a função de agendamento
      const resultMessage = await handleScheduling(personName, dateParam, timeParam);
      responsePayload = createResponse(resultMessage);
    } catch (error) {
      console.error("Erro no fluxo de agendamento:", error);
      responsePayload = createResponse("Houve um erro interno ao tentar agendar. Por favor, tente mais tarde.");
    }
  }

  response.json(responsePayload);
});

// --- FUNÇÕES AUXILIARES ---

function getPersonName(contexts) {
  if (!contexts || contexts.length === 0) return null;
  const contextWithName = contexts.find(ctx => ctx.parameters && ctx.parameters["person.original"]);
  return contextWithName ? contextWithName.parameters["person.original"] : null;
}

function createResponse(text) {
  return {
    fulfillmentMessages: [{ text: { text: [text] } }]
  };
}

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (ATUALIZADA) ---
async function handleScheduling(name, dateParam, timeParam) {
  if (!dateParam || !timeParam) {
    // Isso acontece se o Dialogflow chamar o webhook sem ter preenchido os parâmetros obrigatórios
    return "Por favor, informe uma data e hora completas para o agendamento.";
  }

  // Combina a data e a hora em um único objeto de data
  // Dialogflow envia a data no formato 'AAAA-MM-DD' e a hora como 'HH:MM:SS'
  const dateISO = dateParam.split('T')[0]; // Garante que pegamos apenas a parte da data
  const requestedDateTime = `${dateISO}T${timeParam.split('T')[1]}`; // Combina data e hora
  
  const requestedDate = new Date(requestedDateTime);
  if (isNaN(requestedDate.getTime())) {
    return "A data e hora que você informou não são válidas. Por favor, tente novamente.";
  }
  
  // Autentica e carrega a planilha
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
  const configSheet = doc.sheetsByTitle['Horarios'];

  // 1. VERIFICAR SE O HORÁRIO DE FUNCIONAMENTO É VÁLIDO
  const dayOfWeek = requestedDate.getDay();
  const requestedTime = requestedDate.getHours() + requestedDate.getMinutes() / 60;
  
  const configRows = await configSheet.getRows();
  const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

  if (!dayConfig || (!dayConfig.InicioManha && !dayConfig.InicioTarde)) {
    return `Desculpe, não funcionamos neste dia (${requestedDate.toLocaleDateString('pt-BR', { weekday: 'long' })}).`;
  }
  
  const isMorningShift = requestedTime >= parseFloat(dayConfig.InicioManha.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimManha.replace(':', '.'));
  const isAfternoonShift = dayConfig.InicioTarde && requestedTime >= parseFloat(dayConfig.InicioTarde.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimTarde.replace(':', '.'));

  if (!isMorningShift && !isAfternoonShift) {
    return "Desculpe, estamos fechados neste horário.";
  }

  // 2. VERIFICAR SE O HORÁRIO JÁ ESTÁ OCUPADO
  const existingAppointments = await scheduleSheet.getRows();
  const isSlotTaken = existingAppointments.some(appointment => {
    // Compara a data salva (em ISO) com a data solicitada
    return appointment.DataHoraAgendamento === requestedDate.toISOString();
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
    DataHoraAgendamento: requestedDate.toISOString(), // Salva em formato universal para comparações futuras
    Status: 'Confirmado'
  });
  
  return `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.`;
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
