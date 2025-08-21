// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
const sheetId = process.env.SHEET_ID;
const TIMEZONE = 'America/Sao_Paulo';
const SERVICE_DURATION_MINUTES = 60; // Duração do serviço em minutos

const getDoc = () => new GoogleSpreadsheet(sheetId);

// Função principal do webhook
app.post("/webhook", async (request, response) => {
    try {
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
        response.json(responsePayload);

    } catch (error) {
        console.error("Erro CRÍTICO no webhook:", error);
        const responsePayload = createResponse("Houve um erro interno. Por favor, tente novamente.");
        response.json(responsePayload);
    }
});

// --- LÓGICA DE AGENDAMENTO ---
async function handleScheduling(name, dateTimeParam) {
    if (!dateTimeParam) {
        return { success: false, message: "Por favor, informe uma data e hora completas." };
    }

    // O Dialogflow envia um objeto com 'start' e 'end'. Pegamos o início.
    const dateTimeString = dateTimeParam.start || dateTimeParam;
    const requestedDate = new Date(dateTimeString);

    if (isNaN(requestedDate.getTime())) {
        return { success: false, message: `Não consegui entender a data. Tente um formato como 'amanhã às 14:00'.` };
    }

    // Validação: não permitir agendamentos no passado
    if (requestedDate < new Date()) {
        return { success: false, message: "Não é possível agendar para uma data ou hora que já passou. Por favor, escolha um horário futuro." };
    }
    
    const doc = await getDoc();
    await doc.useServiceAccountAuth(creds);
    await doc.loadInfo();
    const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
    const configSheet = doc.sheetsByTitle['Horarios'];

    // Lógica de verificação de horário de funcionamento (corrigida)
    const { isOpen, dayName } = await checkBusinessHours(requestedDate, configSheet);
    if (!isOpen) {
        return { success: false, message: `Desculpe, estamos fechados neste horário ou não funcionamos neste dia (${dayName}).` };
    }

    // Lógica de verificação de conflitos (com duração)
    const hasConflict = await checkConflicts(requestedDate, scheduleSheet);
    if (hasConflict) {
        return { success: false, message: "Este horário já está ocupado ou conflita com outro agendamento. Por favor, escolha outro." };
    }
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(requestedDate);
    await saveAppointment(name, requestedDate, scheduleSheet);
    
    return { success: true, message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}. 💈` };
}

// --- FUNÇÕES UTILITÁRIAS ---

async function checkBusinessHours(date, configSheet) {
    const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(date);
    
    // Converte a data para uma string no formato de São Paulo para extrair os componentes corretos
    const localDateTime = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
    const dayOfWeek = localDateTime.getDay(); // 0=Dom, 1=Seg...
    const requestedTime = localDateTime.getHours() + localDateTime.getMinutes() / 60;
    
    const configRows = await configSheet.getRows();
    const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);

    if (!dayConfig || !dayConfig.InicioManha) return { isOpen: false, dayName };

    const timeToDecimal = (str) => parseFloat(str.replace(':', '.'));
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

function getPersonName(contexts) { /* ...código da versão anterior... */ }
function createResponse(text, context = null) { /* ...código da versão anterior... */ }

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`);
});
