// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const sheetId = process.env.SHEET_ID;
const doc = new GoogleSpreadsheet(sheetId);
const TIMEZONE = 'America/Sao_Paulo';

// Função principal do webhook
app.post("/webhook", async (request, response) => {
  const intent = request.body.queryResult.intent.displayName;
  let responsePayload;

  if (intent === "AgendarHorario") {
    const dateParam = request.body.queryResult.parameters.data;
    const timeParam = request.body.queryResult.parameters.hora;
    const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
    
    try {
      const result = await handleScheduling(personName, dateParam, timeParam);
      
      if (result.success) {
        responsePayload = createResponse(result.message, true);
      } else {
        const currentSession = request.body.session;
        responsePayload = createResponse(result.message, false, `${currentSession}/contexts/aguardando_agendamento`);
      }

    } catch (error) {
      console.error("Erro CRÍTICO no fluxo de agendamento:", error);
      responsePayload = createResponse("Houve um erro interno. Por favor, tente mais tarde.");
    }
  } else {
    responsePayload = createResponse("Webhook contatado, mas a intenção não é AgendarHorario.");
  }

  response.json(responsePayload);
});

// --- FUNÇÕES AUXILIARES ---

function getPersonName(contexts) {
  if (!contexts || !contexts.length) return null;
  const contextWithName = contexts.find(ctx => ctx.parameters && ctx.parameters["person.original"]);
  return contextWithName ? contextWithName.parameters["person.original"] : null;
}

function createResponse(text, endInteraction = false, context = null) {
  const payload = {
    fulfillmentMessages: [{ text: { text: [text] } }]
  };
  if (context && !endInteraction) {
    payload.outputContexts = [{
        name: context,
        lifespanCount: 2
    }];
  }
  return payload;
}

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (COM A CORREÇÃO) ---
async function handleScheduling(name, dateParam, timeParam) {
  if (!dateParam || !timeParam) {
    return { success: false, message: "Por favor, informe uma data e hora completas." };
  }

  // ***** A CORREÇÃO DEFINITIVA ESTÁ AQUI *****
  // O Dialogflow envia objetos. Precisamos extrair a string de dentro deles.
  // A string de data/hora vem no formato "2025-08-22T12:00:00-03:00".
  const dateString = dateParam.start ? dateParam.start.split('T')[0] : dateParam.split('T')[0];
  const timeString = timeParam.start ? timeParam.start.split('T')[1] : timeParam.split('T')[1];

  if (!dateString || !timeString) {
      return { success: false, message: "Não consegui extrair a data ou a hora da sua resposta. Tente de novo." };
  }
  
  // Combina a parte da data com a parte da hora para formar uma data completa e válida
  const requestedDateTimeString = `${dateString}T${timeString}`;
  
  const requestedDate = new Date(requestedDateTimeString);
  
  if (isNaN(requestedDate.getTime())) {
    return { success: false, message: "A data e hora que você informou não são válidas." };
  }
  
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
  const configSheet = doc.sheetsByTitle['Horarios'];
  
  // 1. VERIFICAR HORÁRIO DE FUNCIONAMENTO
  const dayOfWeek = requestedDate.getDay();
  const requestedTime = requestedDate.getHours() + requestedDate.getMinutes() / 60;
  
  const configRows = await configSheet.getRows();
  const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

  if (!dayConfig || (!dayConfig.InicioManha && !dayConfig.InicioTarde)) {
    const dayName = requestedDate.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: TIMEZONE });
    return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
  }
  
  const isMorningShift = requestedTime >= parseFloat(dayConfig.InicioManha.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimManha.replace(':', '.'));
  const isAfternoonShift = dayConfig.InicioTarde && requestedTime >= parseFloat(dayConfig.InicioTarde.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimTarde.replace(':', '.'));

  if (!isMorningShift && !isAfternoonShift) {
    return { success: false, message: "Desculpe, estamos fechados neste horário. Por favor, escolha outro." };
  }

  // 2. VERIFICAR DISPONIBILIDADE
  const existingAppointments = await scheduleSheet.getRows();
  const isSlotTaken = existingAppointments.some(appointment => appointment.DataHoraISO === requestedDate.toISOString());

  if (isSlotTaken) {
    return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
  }
  
  // 3. SALVAR AGENDAMENTO
  const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE
  }).format(requestedDate);

  await scheduleSheet.addRow({
    NomeCliente: name,
    DataHoraFormatada: formattedDateForUser,
    DataHoraISO: requestedDate.toISOString(),
    TimestampAgendamento: new Date().toISOString(),
    Status: 'Confirmado'
  });
  
  return { success: true, message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.` };
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
