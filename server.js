// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
const sheetId = process.env.SHEET_ID;
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
    if (!dateTimeParam || !dateTimeParam.start) {
        return { success: false, message: "Por favor, informe uma data e hora completas." };
    }

    const requestedDate = new Date(dateTimeParam.start);

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
        throw new Error("Planilhas 'Agendamentos Barbearia' ou 'Horarios' não encontradas.");
    }

    const { isOpen, dayName } = await checkBusinessHours(requestedDate, configSheet);
    if (!isOpen) {
        return { success: false, message: `Desculpe, não funcionamos em ${dayName}. Por favor, escolha outro dia.` };
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

async function checkBusinessHours(date, configSheet) {
    // A forma mais segura de obter os componentes da data no fuso horário local
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });

    const parts = formatter.formatToParts(date);
    const getValue = type => parts.find(p => p.type === type)?.value;

    const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const dayOfWeek = dayMap[getValue('weekday')];
    const requestedTime = parseInt(getValue('hour')) + parseInt(getValue('minute')) / 60;
    
    const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(date);
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

// -- As funções abaixo não precisam de alteração --

function validateEnvironment() { /* ...cole o código da versão anterior... */ }
function validateRequest(request) { /* ...cole o código da versão anterior... */ }
async function checkConflicts(requestedDate, scheduleSheet) { /* ...cole o código da versão anterior... */ }
async function saveAppointment(name, requestedDate, scheduleSheet) { /* ...cole o código da versão anterior... */ }
function getPersonName(contexts) { /* ...cole oódigo da versão anterior... */ }
function createResponse(text, context = null) { /* ...cole o código da versão anterior... */ }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`);
});
