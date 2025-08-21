// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const sheetId = process.env.SHEET_ID;
const TIMEZONE_OFFSET_HOURS = -3; // UTC-3 para o Horário de Brasília

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

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (COM LÓGICA DE TIMEZONE CORRIGIDA) ---
async function handleScheduling(name, dateParam, timeParam) {
    try {
        const dateValue = dateParam.start || dateParam;
        const timeValue = timeParam.start || timeParam;
        const dateTimeString = `${dateValue.split('T')[0]}T${timeValue.split('T')[1]}`;
        
        const requestedDateUTC = new Date(dateTimeString);
        if (isNaN(requestedDateUTC.getTime())) throw new Error("Data inválida");

        // **CORREÇÃO DE FUSO HORÁRIO (LÓGICA ROBUSTA)**
        const userLocalDate = new Date(requestedDateUTC.getTime() + (TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000));
        
        const dayOfWeek = userLocalDate.getUTCDay(); // Dom=0, Seg=1...
        const hours = userLocalDate.getUTCHours();
        const minutes = userLocalDate.getUTCMinutes();
        const requestedTime = hours + minutes / 60;
        
        const doc = getDoc();
        await doc.useServiceAccountAuth(creds);
        await doc.loadInfo();
        const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
        const configSheet = doc.sheetsByTitle['Horarios'];
        
        // 1. VERIFICAR HORÁRIO DE FUNCIONAMENTO
        const configRows = await configSheet.getRows();
        const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);
        const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(requestedDateUTC);

        if (!dayConfig || !dayConfig.InicioManha) {
            return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
        }
        
        const inicioManha = parseFloat(dayConfig.InicioManha.replace(':', '.'));
        const fimManha = parseFloat(dayConfig.FimManha.replace(':', '.'));
        const inicioTarde = dayConfig.InicioTarde ? parseFloat(dayConfig.InicioTarde.replace(':', '.')) : null;
        const fimTarde = dayConfig.FimTarde ? parseFloat(dayConfig.FimTarde.replace(':', '.')) : null;

        const isMorningValid = (requestedTime >= inicioManha && requestedTime < fimManha);
        const isAfternoonValid = (inicioTarde && requestedTime >= inicioTarde && requestedTime < fimTarde);

        // Lógica de verificação corrigida e simplificada
        if (!isMorningValid && !isAfternoonValid) {
            return { success: false, message: "Desculpe, estamos fechados neste horário. Por favor, escolha outro." };
        }

        // 2. VERIFICAR DISPONIBILIDADE
        const existingAppointments = await scheduleSheet.getRows();
        const isSlotTaken = existingAppointments.some(appointment => appointment.DataHoraISO === requestedDateUTC.toISOString());

        if (isSlotTaken) {
            return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
        }
        
        // 3. SALVAR AGENDAMENTO
        const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(requestedDateUTC);

        await scheduleSheet.addRow({
            NomeCliente: name,
            DataHoraFormatada: formattedDateForUser,
            DataHoraISO: requestedDateUTC.toISOString(),
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
