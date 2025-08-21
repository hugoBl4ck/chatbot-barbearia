// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
const sheetId = process.env.SHEET_ID;
// Corrigido para corresponder ao seu Dialogflow
const TIMEZONE = 'America/Buenos_Aires'; 
const SERVICE_DURATION_MINUTES = 60;

// Validação de ambiente no início para evitar erros silenciosos
validateEnvironment();

// --- FUNÇÃO PRINCIPAL DO WEBHOOK ---
app.post("/webhook", async (request, response) => {
    try {
        validateRequest(request);
        const intent = request.body.queryResult.intent.displayName;
        let result;

        if (intent === "AgendarHorario") {
            const dateTimeParam = request.body.queryResult.parameters['date-time'];
            const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
            result = await handleScheduling(personName, dateTimeParam);
        } else {
            result = { success: true, message: "Webhook contatado, mas a intenção não é de agendamento." };
        }
        
        const currentSession = request.body.session;
        const context = result.success ? null : `${currentSession}/contexts/aguardando_agendamento`;
        const responsePayload = createResponse(result.message, context);
        return response.json(responsePayload);

    } catch (error) {
        console.error("Erro CRÍTICO no webhook:", error);
        const responsePayload = createResponse("Houve um erro interno. Por favor, tente novamente.");
        return response.json(responsePayload);
    }
});

// --- LÓGICA PRINCIPAL DE AGENDAMENTO ---
async function handleScheduling(name, dateTimeParam) {
    if (!dateTimeParam || (typeof dateTimeParam === 'object' && !dateTimeParam.start)) {
        return { success: false, message: "Por favor, informe uma data e hora completas." };
    }

    const dateTimeString = dateTimeParam.start || dateTimeParam;
    const requestedDate = new Date(dateTimeString);

    if (isNaN(requestedDate.getTime())) {
        return { success: false, message: `Não consegui entender a data. Tente um formato como 'amanhã às 14:00'.` };
    }

    if (requestedDate < new Date()) {
        return { success: false, message: "Não é possível agendar para um horário que já passou." };
    }
    
    const doc = new GoogleSpreadsheet(sheetId);
    await doc.useServiceAccountAuth(creds);
    await doc.loadInfo();
    const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
    const configSheet = doc.sheetsByTitle['Horarios'];

    if (!scheduleSheet || !configSheet) {
        throw new Error("Uma ou mais planilhas ('Agendamentos Barbearia', 'Horarios') não foram encontradas.");
    }

    const { isOpen, dayName } = await checkBusinessHours(requestedDate, configSheet);
    if (!isOpen) {
        return { success: false, message: `Desculpe, estamos fechados neste horário ou não funcionamos no dia de ${dayName}.` };
    }

    const hasConflict = await checkConflicts(requestedDate, scheduleSheet);
    if (hasConflict) {
        return { success: false, message: "Este horário já está ocupado ou conflita com outro agendamento. Por favor, escolha outro." };
    }
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(requestedDate);
    await saveAppointment(name, requestedDate, scheduleSheet);
    
    return { success: true, message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.` };
}

// --- FUNÇÕES UTILITÁRIAS ---

function validateEnvironment() {
    if (!process.env.GOOGLE_CREDENTIALS || !process.env.SHEET_ID) {
        throw new Error("Variáveis de ambiente GOOGLE_CREDENTIALS ou SHEET_ID não definidas.");
    }
}

function validateRequest(request) {
    if (!request.body || !request.body.queryResult || !request.body.queryResult.intent) {
        throw new Error("Requisição do Dialogflow inválida.");
    }
}

async function checkBusinessHours(date, configSheet) {
    // ESTA É A CORREÇÃO MAIS IMPORTANTE E DEFINITIVA
    // Cria uma string de data/hora formatada para o timezone correto
    const localDateTimeString = date.toLocaleString("en-CA", { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    // Cria um novo objeto Date a partir da string local, garantindo que não haja conversões de fuso indesejadas
    const localDate = new Date(localDateTimeString.replace(' ', 'T').split(',')[0]);
    
    const dayOfWeek = localDate.getDay(); // 0=Dom, 1=Seg...
    const requestedTime = localDate.getHours() + localDate.getMinutes() / 60;
    
    const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(date);
    const configRows = await configSheet.getRows();
    const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

    if (!dayConfig || !dayConfig.InicioManha) return { isOpen: false, dayName };

    const timeToDecimal = (str) => {
        if (!str || typeof str !== 'string') return 0;
        return parseFloat(str.replace(':', '.'));
    }
    
    const inicioManha = timeToDecimal(dayConfig.InicioManha);
    const fimManha = timeToDecimal(dayConfig.FimManha);

    if (requestedTime >= inicioManha && requestedTime < fimManha) return { isOpen: true, dayName };
    
    if (dayConfig.InicioTarde && dayConfig.FimTarde) {
        const inicioTarde = timeToDecimal(dayConfig.InicioTarde);
        const fimTarde = timeToDecimal(dayConfig.FimTarde);
        if (requestedTime >= inicioTarde && requestedTime < fimTarde) return { isOpen: true, dayName };
    }
    
    return { isOpen: false, dayName };
}

async function checkConflicts(requestedDate, scheduleSheet) {
    const existingAppointments = await scheduleSheet.getRows();
    const requestedStartTime = requestedDate.getTime();
    const requestedEndTime = requestedStartTime + SERVICE_DURATION_MINUTES * 60 * 1000;

    return existingAppointments.some(appointment => {
        if (!appointment.DataHoraISO) return false;
        const existingStartTime = new Date(appointment.DataHoraISO).getTime();
        const duration = (parseInt(appointment.DuracaoMinutos) || SERVICE_DURATION_MINUTES) * 60 * 1000;
        const existingEndTime = existingStartTime + duration;
        return (requestedStartTime < existingEndTime) && (requestedEndTime > existingStartTime);
    });
}

async function saveAppointment(name, requestedDate, scheduleSheet) {
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(requestedDate);
    await scheduleSheet.addRow({
        NomeCliente: name,
        DataHoraFormatada: formattedDateForUser,
        DataHoraISO: requestedDate.toISOString(),
        TimestampAgendamento: new Date().toISOString(),
        Status: 'Confirmado',
        DuracaoMinutos: SERVICE_DURATION_MINUTES
    });
}

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

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`);
});
