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
    
    try {
      const resultMessage = await handleSchedulingDebug(dateParam, timeParam);
      // Para depuração, sempre mantemos a conversa ativa
      const currentSession = request.body.session;
      responsePayload = createResponse(resultMessage, `${currentSession}/contexts/aguardando_agendamento`);

    } catch (error) {
      console.error("Erro CRÍTICO no fluxo de agendamento:", error);
      responsePayload = createResponse(`Erro interno: ${error.message}`);
    }
  } else {
    responsePayload = createResponse("Webhook contatado, mas a intenção não é AgendarHorario.");
  }

  response.json(responsePayload);
});

// --- FUNÇÃO DE RESPOSTA ---
function createResponse(text, context = null) {
  const payload = {
    fulfillmentMessages: [{ text: { text: [text] } }]
  };
  if (context) {
    payload.outputContexts = [{ name: context, lifespanCount: 2 }];
  }
  return payload;
}

// --- FUNÇÃO DE AGENDAMENTO (VERSÃO DE DEPURAÇÃO) ---
async function handleSchedulingDebug(dateParam, timeParam) {
  if (!dateParam || !timeParam) {
    return "DEBUG: Parâmetros de data ou hora faltando.";
  }

  const dateTimeString = dateParam.start ? dateParam.start : dateParam;
  const requestedDate = new Date(dateTimeString);

  if (isNaN(requestedDate.getTime())) {
    return `DEBUG: Data inválida criada a partir de '${dateTimeString}'.`;
  }
  
  const timePart = dateTimeString.split('T')[1];
  const [hours, minutes] = timePart.split(':').map(Number);
  const requestedTime = hours + minutes / 60;
  const dayOfWeek = requestedDate.getUTCDay();
  
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
  const configSheet = doc.sheetsByTitle['Horarios'];
  const configRows = await configSheet.getRows();
  const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

  if (!dayConfig) {
    return `DEBUG: Não encontrei configuração para o DiaDaSemana=${dayOfWeek}. Verifique a planilha 'Horarios'.`;
  }

  const inicioManha = parseFloat(dayConfig.InicioManha.replace(':', '.'));
  const fimManha = parseFloat(dayConfig.FimManha.replace(':', '.'));
  const isMorningShift = requestedTime >= inicioManha && requestedTime < fimManha;

  let debugMessage = [
    `--- DADOS DE DEPURAÇÃO ---`,
    `Data Recebida: ${dateTimeString}`,
    `Dia da Semana Calculado: ${dayOfWeek} (Dom=0, Seg=1...)`,
    `Hora Calculada: ${requestedTime}`,
    `--- Planilha 'Horarios' (Linha ${dayOfWeek}) ---`,
    `DiaDaSemana Lido: ${dayConfig.DiaDaSemana}`,
    `Início Manhã Lido: ${dayConfig.InicioManha} (${inicioManha})`,
    `Fim Manhã Lido: ${dayConfig.FimManha} (${fimManha})`,
    `--- Verificação ---`,
    `Está na Manhã? (${requestedTime} >= ${inicioManha} && ${requestedTime} < ${fimManha}) = ${isMorningShift}`
  ];
  
  if (dayConfig.InicioTarde) {
      const inicioTarde = parseFloat(dayConfig.InicioTarde.replace(':', '.'));
      const fimTarde = parseFloat(dayConfig.FimTarde.replace(':', '.'));
      const isAfternoonShift = requestedTime >= inicioTarde && requestedTime < fimTarde;
      debugMessage.push(`Início Tarde Lido: ${dayConfig.InicioTarde} (${inicioTarde})`);
      debugMessage.push(`Fim Tarde Lido: ${dayConfig.FimTarde} (${fimTarde})`);
      debugMessage.push(`Está na Tarde? (${requestedTime} >= ${inicioTarde} && ${requestedTime} < ${fimTarde}) = ${isAfternoonShift}`);
  }

  return debugMessage.join('\n');
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
