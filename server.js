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

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (CORRIGIDA PELO ESPECIALISTA) ---
async function handleScheduling(name, dateParam, timeParam) {
    if (!dateParam || !timeParam) {
        return { success: false, message: "Por favor, informe uma data e hora completas." };
    }

    try {
        const dateValue = dateParam.start || dateParam;
        const timeValue = timeParam.start || timeParam;
        const dateTimeString = `${dateValue.split('T')[0]}T${timeValue.split('T')[1]}`;
        
        const requestedDate = new Date(dateTimeString);
        if (isNaN(requestedDate.getTime())) throw new Error("Data inválida");

        const doc = getDoc();
        await doc.useServiceAccountAuth(creds);
        await doc.loadInfo();
        const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
        const configSheet = doc.sheetsByTitle['Horarios'];
        
        // **CORREÇÃO 2: Tratamento de Timezone Consistente**
        // Usamos toLocaleString para garantir que o dia da semana seja o do Brasil
        const dayOfWeek = new Date(requestedDate.toLocaleString("en-US", {timeZone: TIMEZONE})).getDay(); // Dom=0, Seg=1...

        // Extrai a hora local de forma segura
        const hourFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, hour: 'numeric', minute: 'numeric', hour12: false });
        const timeString = hourFormatter.format(requestedDate);
        const [hours, minutes] = timeString.split(':').map(Number);
        const requestedTime = hours + minutes / 60;

        // 1. VERIFICAR HORÁRIO DE FUNCIONAMENTO
        const configRows = await configSheet.getRows();
        const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);
        const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(requestedDate);

        if (!dayConfig || !dayConfig.InicioManha) {
            return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
        }
        
        const inicioManha = parseFloat(dayConfig.InicioManha.replace(':', '.'));
        const fimManha = parseFloat(dayConfig.FimManha.replace(':', '.'));
        const inicioTarde = dayConfig.InicioTarde ? parseFloat(dayConfig.InicioTarde.replace(':', '.')) : null;
        const fimTarde = dayConfig.FimTarde ? parseFloat(dayConfig.FimTarde.replace(':', '.')) : null;

        const isMorningValid = (requestedTime >= inicioManha && requestedTime < fimManha);
        const isAfternoonValid = (inicioTarde && requestedTime >= inicioTarde && requestedTime < fimTarde);

        // **CORREÇÃO 1: Lógica de Verificação de Horários**
        // Esta lógica agora é universal e correta para todos os dias
        if (!isMorningValid && !isAfternoonValid) {
            return { success: false, message: "Desculpe, estamos fechados neste horário. Por favor, escolha outro." };
        }

        // 2. VERIFICAR DISPONIBILIDADE
        const existingAppointments = await scheduleSheet.getRows();
        const isSlotTaken = existingAppointments.some(appointment => appointment.DataHoraISO === requestedDate.toISOString());

        if (isSlotTaken) {
            return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
        }
        
        // 3. SALVAR AGENDAMENTO
        const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(requestedDate);

        await scheduleSheet.addRow({
            NomeCliente: name,
            DataHoraFormatada: formattedDateForUser,
            DataHoraISO: requestedDate.toISOString(),
            TimestampAgendamento: new Date().toISOString(),
            Status: 'Confirmado'
        });
        
        return { success: true, message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.` };

    } catch (e) {
        console.error("Erro na lógica de agendamento:", e);
        return { success: false, message: "Não consegui processar a data. Tente um formato como 'amanhã às 10:00'." };
    }
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
    console.log("Your app is listening on port " + listener.address().port);
});
