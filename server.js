// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const sheetId = process.env.SHEET_ID;
const TIMEZONE = 'America/Sao_Paulo';

const getDoc = () => new GoogleSpreadsheet(sheetId);

// Função principal do webhook
app.post("/webhook", async (request, response) => {
    const intent = request.body.queryResult.intent.displayName;
    let responsePayload;

    try {
        if (intent === "AgendarHorario") {
            const dateParam = request.body.queryResult.parameters.data;
            const timeParam = request.body.queryResult.parameters.hora;
            const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
            const result = await handleScheduling(personName, dateParam, timeParam);
            
            const currentSession = request.body.session;
            // A conversa só termina se o agendamento for um sucesso.
            const context = result.success ? null : `${currentSession}/contexts/aguardando_agendamento`;
            responsePayload = createResponse(result.message, context);

        } else {
            responsePayload = createResponse("Webhook contatado, mas a intenção não é AgendarHorario.");
        }
    } catch (error) {
        console.error("Erro CRÍTICO no webhook:", error);
        responsePayload = createResponse("Houve um erro interno. Por favor, tente mais tarde.");
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

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (VERSÃO FINAL E ROBUSTA) ---
async function handleScheduling(name, dateParam, timeParam) {
    // Agora o nosso código verifica se os parâmetros estão faltando
    if (!dateParam || !timeParam || !dateParam.start || !timeParam.start) {
        return { success: false, message: "Por favor, informe um dia e um horário completos." };
    }

    const dateTimeString = `${dateParam.start.split('T')[0]}T${timeParam.start.split('T')[1]}`;
    const requestedDate = new Date(dateTimeString);

    if (isNaN(requestedDate.getTime())) {
        return { success: false, message: "A data e hora que você informou não são válidas." };
    }
    
    const timePart = dateTimeString.split('T')[1];
    const [hours, minutes] = timePart.split(':').map(Number);
    const requestedTime = hours + minutes / 60;
    const dayOfWeek = requestedDate.getUTCDay();
    
    const doc = getDoc();
    await doc.useServiceAccountAuth(creds);
    await doc.loadInfo();

    const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
    const configSheet = doc.sheetsByTitle['Horarios'];
    
    const configRows = await configSheet.getRows();
    const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

    if (!dayConfig || (!dayConfig.InicioManha && !dayConfig.InicioTarde)) {
        const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(requestedDate);
        return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
    }
    
    const isMorningShift = requestedTime >= parseFloat(dayConfig.InicioManha.replace(':', '.')) && requestedTime <= parseFloat(dayConfig.FimManha.replace(':', '.'));
    const isAfternoonShift = dayConfig.InicioTarde && requestedTime >= parseFloat(dayConfig.InicioTarde.replace(':', '.')) && requestedTime <= parseFloat(dayConfig.FimTarde.replace(':', '.'));

    if (!isMorningShift && !isAfternoonShift) {
        if (dayOfWeek == 6 && isMorningShift) {} else {
            return { success: false, message: "Desculpe, estamos fechados neste horário. Por favor, escolha outro." };
        }
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
