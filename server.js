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
        responsePayload = createResponse(result.message);
      } else {
        const currentSession = request.body.session;
        responsePayload = createResponse(result.message, `${currentSession}/contexts/aguardando_agendamento`);
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

function createResponse(text, context = null) {
  const payload = {
    fulfillmentMessages: [{ text: { text: [text] } }]
  };
  if (context) {
    payload.outputContexts = [{ name: context, lifespanCount: 2 }];
  }
  return payload;
}

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (VERSÃO DE DEPURAÇÃO) ---
async function handleScheduling(name, dateParam, timeParam) {
    
  // ***** PASSO DE DEPURAÇÃO: Imprime os valores recebidos nos logs *****
  console.log("--- INICIANDO DEPURAÇÃO ---");
  console.log("Valor de 'dateParam' recebido:", JSON.stringify(dateParam, null, 2));
  console.log("Valor de 'timeParam' recebido:", JSON.stringify(timeParam, null, 2));

  if (!dateParam || !timeParam) {
    return { success: false, message: "Por favor, informe uma data e hora completas." };
  }

  // ... (o resto do código continua igual)
  const dateString = dateParam.start ? dateParam.start.split('T')[0] : dateParam.split('T')[0];
  const timeString = timeParam.start ? timeParam.start.split('T')[1] : timeParam.split('T')[1];

  if (!dateString || !timeString) {
      return { success: false, message: "Não consegui extrair a data ou a hora. Tente novamente." };
  }
  
  const requestedDateTimeString = `${dateString}T${timeString}`;
  const requestedDate = new Date(requestedDateTimeString);
  
  if (isNaN(requestedDate.getTime())) {
    return { success: false, message: "A data e hora que você informou não são válidas." };
  }
  
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
  const configSheet = doc.sheetsBytitle['Horarios'];
  
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false });
  const parts = formatter.formatToParts(requestedDate);
  const getValue = (type) => parts.find(p => p.type === type).value;
  
  let dayOfWeek = parseInt(getValue('weekday'));
  if(dayOfWeek === 7) dayOfWeek = 0;
  
  const hours = parseInt(getValue('hour'));
  const minutes = parseInt(getValue('minute'));
  const requestedTime = hours + minutes / 60;
  
  const configRows = await configSheet.getRows();
  const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

  if (!dayConfig || (!dayConfig.InicioManha && !dayConfig.InicioTarde)) {
    const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(requestedDate);
    return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
  }
  
  const isMorningShift = requestedTime >= parseFloat(dayConfig.InicioManha.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimManha.replace(':', '.'));
  const isAfternoonShift = dayConfig.InicioTarde && requestedTime >= parseFloat(dayConfig.InicioTarde.replace(':', '.')) && requestedTime < parseFloat(dayConfig.FimTarde.replace(':', '.'));

  if (!isMorningShift && !isAfternoonShift) {
    return { success: false, message: "Desculpe, estamos fechados neste horário. Por favor, escolha outro." };
  }

  const existingAppointments = await scheduleSheet.getRows();
  const isSlotTaken = existingAppointments.some(appointment => appointment.DataHoraISO === requestedDate.toISOString());

  if (isSlotTaken) {
    return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
  }
  
  const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(requestedDate);

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
