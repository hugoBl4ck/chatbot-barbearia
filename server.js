// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');
const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const sheetId = process.env.SHEET_ID;
const TIMEZONE = 'America/Sao_Paulo';

// Cache para reutilizar a instância do documento
let docInstance = null;

const getDoc = async () => {
    if (!docInstance) {
        docInstance = new GoogleSpreadsheet(sheetId);
        await docInstance.useServiceAccountAuth(creds);
    }
    return docInstance;
};

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

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO (CORRIGIDA) ---
async function handleScheduling(name, dateParam, timeParam) {
    try {
        // Validação básica
        if (!dateParam || !timeParam) {
            return { success: false, message: "Por favor, informe uma data e hora completas." };
        }
        
        // Extrair valores de data e hora
        const dateValue = dateParam.start || dateParam;
        const timeValue = timeParam.start || timeParam;
        const dateTimeString = `${dateValue.split('T')[0]}T${timeValue.split('T')[1]}`;
        
        // Criar objeto Date em UTC
        const requestedDateUTC = new Date(dateTimeString);
        if (isNaN(requestedDateUTC.getTime())) {
            throw new Error("Data inválida");
        }
        
        // **CORREÇÃO: Obter dia da semana no fuso horário correto**
        // Criar uma data no fuso horário de São Paulo
        const options = { timeZone: TIMEZONE, weekday: 'long' };
        const dayName = new Intl.DateTimeFormat('pt-BR', options).format(requestedDateUTC);
        
        // Mapear nome do dia para número (1=Segunda, 2=Terça, ..., 6=Sábado)
        const dayMap = {
            'segunda': 1, 'terça': 2, 'quarta': 3, 'quinta': 4, 'sexta': 5, 'sábado': 6
        };
        const dayOfWeek = dayMap[dayName.toLowerCase()];
        
        // Se for domingo, retornar erro (não está na planilha)
        if (dayOfWeek === undefined) {
            return { success: false, message: `Desculpe, não funcionamos aos domingos.` };
        }
        
        // **CORREÇÃO: Obter hora e minuto no fuso horário correto**
        const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
            timeZone: TIMEZONE,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        
        const timeParts = timeFormatter.formatToParts(requestedDateUTC);
        const hourPart = timeParts.find(part => part.type === 'hour').value;
        const minutePart = timeParts.find(part => part.type === 'minute').value;
        const hours = parseInt(hourPart);
        const minutes = parseInt(minutePart);
        const requestedTime = hours + minutes / 60;
        
        // Log para depuração
        console.log(`Data agendada: ${requestedDateUTC.toISOString()}`);
        console.log(`Dia da semana: ${dayName} (${dayOfWeek})`);
        console.log(`Hora agendada: ${hours}:${minutes} (${requestedTime})`);
        
        // Carregar documento e planilhas
        const doc = await getDoc();
        await doc.loadInfo();
        
        // Verificar se as planilhas existem
        if (!doc.sheetsByTitle['Agendamentos Barbearia'] || !doc.sheetsByTitle['Horarios']) {
            throw new Error("Planilhas necessárias não encontradas");
        }
        
        const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
        const configSheet = doc.sheetsByTitle['Horarios'];
        
        // 1. VERIFICAR HORÁRIO DE FUNCIONAMENTO
        const configRows = await configSheet.getRows();
        
        // **CORREÇÃO: Buscar dia da semana corretamente**
        const dayConfig = configRows.find(row => parseInt(row.DiaDaSemana) === dayOfWeek);
        
        if (!dayConfig) {
            return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
        }
        
        // **CORREÇÃO: Converter horários com tratamento robusto**
        const parseTime = (timeStr) => {
            if (!timeStr) return null;
            const parts = timeStr.split(':');
            if (parts.length !== 2) return null;
            const hours = parseInt(parts[0]);
            const minutes = parseInt(parts[1]);
            return hours + minutes / 60;
        };
        
        const inicioManha = parseTime(dayConfig.InicioManha);
        const fimManha = parseTime(dayConfig.FimManha);
        const inicioTarde = parseTime(dayConfig.InicioTarde);
        const fimTarde = parseTime(dayConfig.FimTarde);
        
        console.log(`Horários de funcionamento: Manhã(${inicioManha}-${fimManha}) Tarde(${inicioTarde}-${fimTarde})`);
        
        // Verificar se o horário está dentro do período de funcionamento
        const isMorningValid = inicioManha !== null && fimManha !== null && 
                              requestedTime >= inicioManha && requestedTime < fimManha;
        const isAfternoonValid = inicioTarde !== null && fimTarde !== null && 
                                requestedTime >= inicioTarde && requestedTime < fimTarde;
        
        if (!isMorningValid && !isAfternoonValid) {
            console.log(`Horário fora do funcionamento: ${requestedTime} não está em [${inicioManha}, ${fimManha}) nem [${inicioTarde}, ${fimTarde})`);
            return { success: false, message: "Desculpe, estamos fechados neste horário. Por favor, escolha outro." };
        }
        
        // 2. VERIFICAR DISPONIBILIDADE
        const existingAppointments = await scheduleSheet.getRows();
        const isSlotTaken = existingAppointments.some(appointment => 
            appointment.DataHoraISO === requestedDateUTC.toISOString()
        );
        
        if (isSlotTaken) {
            return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
        }
        
        // 3. SALVAR AGENDAMENTO
        const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { 
            dateStyle: 'full', 
            timeStyle: 'short', 
            timeZone: TIMEZONE 
        }).format(requestedDateUTC);
        
        await scheduleSheet.addRow({
            NomeCliente: name,
            DataHoraFormatada: formattedDateForUser,
            DataHoraISO: requestedDateUTC.toISOString(),
            TimestampAgendamento: new Date().toISOString(),
            Status: 'Confirmado'
        });
        
        return { 
            success: true, 
            message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.` 
        };
    } catch (e) {
        console.error("Erro na lógica de agendamento:", e);
        return { 
            success: false, 
            message: "Não consegui processar a data. Tente um formato como 'amanhã às 10:00'." 
        };
    }
}

// Inicia o servidor
const listener = app.listen(process.env.PORT, () => {
    console.log("Your app é listening on port " + listener.address().port);
});
