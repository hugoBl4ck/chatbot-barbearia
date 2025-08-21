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
        
        // **CORREÇÃO: Usar Intl.DateTimeFormat para obter componentes no fuso correto**
        const formatter = new Intl.DateTimeFormat('pt-BR', {
            timeZone: TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        
        // Formatar a data no fuso horário correto
        const formattedParts = formatter.formatToParts(requestedDateUTC);
        
        // Extrair componentes da data
        const components = {};
        formattedParts.forEach(part => {
            components[part.type] = part.value;
        });
        
        // **CORREÇÃO: Calcular o dia da semana corretamente**
        // Criar uma data usando os componentes locais
        const localDate = new Date(
            parseInt(components.year),
            parseInt(components.month) - 1, // Mês é 0-11 em JavaScript
            parseInt(components.day),
            parseInt(components.hour),
            parseInt(components.minute)
        );
        
        const dayOfWeek = localDate.getDay(); // 0=domingo, 1=segunda, etc.
        const hours = parseInt(components.hour);
        const minutes = parseInt(components.minute);
        const requestedTime = hours + minutes / 60;
        
        // Log para depuração
        console.log(`Data agendada: ${components.day}/${components.month}/${components.year}`);
        console.log(`Hora agendada: ${components.hour}:${components.minute}`);
        console.log(`Dia da semana: ${dayOfWeek} (0=Dom, 1=Seg, ..., 6=Sáb)`);
        console.log(`Hora decimal: ${requestedTime}`);
        
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
        
        // **CORREÇÃO: Garantir comparação numérica**
        const dayConfig = configRows.find(row => parseInt(row.DiaDaSemana) === dayOfWeek);
        const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: TIMEZONE }).format(requestedDateUTC);
        
        if (!dayConfig || !dayConfig.InicioManha) {
            return { success: false, message: `Desculpe, não funcionamos neste dia (${dayName}).` };
        }
        
        // Converter horários para números decimais
        const inicioManha = parseFloat(dayConfig.InicioManha.replace(':', '.'));
        const fimManha = parseFloat(dayConfig.FimManha.replace(':', '.'));
        const inicioTarde = dayConfig.InicioTarde ? parseFloat(dayConfig.InicioTarde.replace(':', '.')) : null;
        const fimTarde = dayConfig.FimTarde ? parseFloat(dayConfig.FimTarde.replace(':', '.')) : null;
        
        // Verificar se o horário está dentro do período de funcionamento
        const isMorningValid = (requestedTime >= inicioManha && requestedTime < fimManha);
        const isAfternoonValid = (inicioTarde && requestedTime >= inicioTarde && requestedTime < fimTarde);
        
        if (!isMorningValid && !isAfternoonValid) {
            console.log(`Horário fora do funcionamento: Manhã(${inicioManha}-${fimManha}) Tarde(${inicioTarde}-${fimTarde})`);
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
    console.log("Your app is listening on port " + listener.address().port);
});
