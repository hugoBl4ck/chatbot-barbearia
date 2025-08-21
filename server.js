// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
const sheetId = process.env.SHEET_ID;
const TIMEZONE = 'America/Sao_Paulo';
const SERVICE_DURATION_MINUTES = 30; // Duração padrão do serviço
const TIMEZONE_OFFSET = -3; // Offset para América/São Paulo (UTC-3)

// Cache para configurações
let configCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos

// --- UTILITÁRIOS DE VALIDAÇÃO ---
function validateEnvironment() {
    const required = ['GOOGLE_CREDENTIALS', 'SHEET_ID'];
    const missing = required.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
        throw new Error(`Variáveis de ambiente obrigatórias não definidas: ${missing.join(', ')}`);
    }
    
    if (!creds.client_email || !creds.private_key) {
        throw new Error('Credenciais do Google inválidas');
    }
}

function validateRequest(request) {
    if (!request.body) {
        throw new Error('Body da requisição não encontrado');
    }
    
    const { queryResult } = request.body;
    if (!queryResult) {
        throw new Error('queryResult não encontrado');
    }
    
    if (!queryResult.intent?.displayName) {
        throw new Error('Intent não identificada');
    }
    
    return true;
}

function validateDateTime(dateParam, timeParam) {
    if (!dateParam || !timeParam) {
        return { valid: false, error: "Por favor, informe uma data e hora completas." };
    }
    
    const dateValue = dateParam.start || dateParam;
    const timeValue = timeParam.start || timeParam;
    
    if (!dateValue || !timeValue) {
        return { valid: false, error: "Formato de data/hora inválido." };
    }
    
    return { valid: true, dateValue, timeValue };
}

// --- UTILITÁRIOS DE DATA/HORA ---
function parseDateTime(dateValue, timeValue) {
    try {
        // Extrair apenas a parte da data (YYYY-MM-DD)
        const datePart = dateValue.split('T')[0];
        
        // Extrair apenas a parte do tempo (HH:MM:SS)
        let timePart;
        if (timeValue.includes('T')) {
            timePart = timeValue.split('T')[1];
        } else {
            timePart = timeValue;
        }
        
        // Remover timezone se presente
        timePart = timePart.split(/[+\-Z]/)[0];
        
        // Combinar data e hora
        const dateTimeString = `${datePart}T${timePart}`;
        const parsedDate = new Date(dateTimeString);
        
        if (isNaN(parsedDate.getTime())) {
            throw new Error("Data inválida após parsing");
        }
        
        return parsedDate;
    } catch (error) {
        throw new Error(`Erro ao processar data/hora: ${error.message}`);
    }
}

function convertToSaoPauloTime(utcDate) {
    // Converte UTC para horário de São Paulo (UTC-3)
    const saoPauloTime = new Date(utcDate.getTime() + (TIMEZONE_OFFSET * 60 * 60 * 1000));
    return saoPauloTime;
}

function timeToDecimal(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) {
        throw new Error(`Formato de hora inválido: ${timeString}`);
    }
    return hours + (minutes / 60);
}

function isBusinessHours(requestedTime, dayConfig) {
    if (!dayConfig || !dayConfig.InicioManha) {
        return false;
    }
    
    try {
        const inicioManha = timeToDecimal(dayConfig.InicioManha);
        const fimManha = timeToDecimal(dayConfig.FimManha);
        
        const isMorningValid = (requestedTime >= inicioManha && requestedTime < fimManha);
        
        if (dayConfig.InicioTarde && dayConfig.FimTarde) {
            const inicioTarde = timeToDecimal(dayConfig.InicioTarde);
            const fimTarde = timeToDecimal(dayConfig.FimTarde);
            const isAfternoonValid = (requestedTime >= inicioTarde && requestedTime < fimTarde);
            
            return isMorningValid || isAfternoonValid;
        }
        
        return isMorningValid;
    } catch (error) {
        console.error('Erro ao validar horário de funcionamento:', error);
        return false;
    }
}

function isDuringBusinessDays(dayOfWeek) {
    // 0 = Domingo, 6 = Sábado
    return dayOfWeek >= 1 && dayOfWeek <= 6; // Segunda a Sábado
}

function isInThePast(date) {
    const now = new Date();
    return date < now;
}

// --- UTILITÁRIOS DE PLANILHA ---
async function getDoc() {
    const doc = new GoogleSpreadsheet(sheetId);
    await doc.useServiceAccountAuth(creds);
    await doc.loadInfo();
    return doc;
}

async function getBusinessConfig() {
    // Verifica cache
    const now = Date.now();
    if (configCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION) {
        return configCache;
    }
    
    try {
        const doc = await getDoc();
        const configSheet = doc.sheetsByTitle['Horarios'];
        
        if (!configSheet) {
            throw new Error('Planilha "Horarios" não encontrada');
        }
        
        const configRows = await configSheet.getRows();
        
        // Atualiza cache
        configCache = configRows;
        cacheTimestamp = now;
        
        return configRows;
    } catch (error) {
        console.error('Erro ao buscar configuração:', error);
        throw new Error('Não foi possível carregar a configuração de horários');
    }
}

async function checkExistingAppointments(requestedDate) {
    try {
        const doc = await getDoc();
        const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
        
        if (!scheduleSheet) {
            throw new Error('Planilha "Agendamentos Barbearia" não encontrada');
        }
        
        const existingAppointments = await scheduleSheet.getRows();
        const requestedDateISO = requestedDate.toISOString();
        
        // Verifica conflitos considerando duração do serviço
        const conflictingAppointments = existingAppointments.filter(appointment => {
            if (!appointment.DataHoraISO) return false;
            
            const appointmentDate = new Date(appointment.DataHoraISO);
            const appointmentEnd = new Date(appointmentDate.getTime() + SERVICE_DURATION_MINUTES * 60 * 1000);
            const requestedEnd = new Date(requestedDate.getTime() + SERVICE_DURATION_MINUTES * 60 * 1000);
            
            // Verifica sobreposição de horários
            return (requestedDate < appointmentEnd && requestedEnd > appointmentDate);
        });
        
        return conflictingAppointments.length > 0;
    } catch (error) {
        console.error('Erro ao verificar agendamentos existentes:', error);
        throw new Error('Não foi possível verificar disponibilidade do horário');
    }
}

async function saveAppointment(name, requestedDate) {
    try {
        const doc = await getDoc();
        const scheduleSheet = doc.sheetsByTitle['Agendamentos Barbearia'];
        
        const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: TIMEZONE
        }).format(requestedDate);
        
        await scheduleSheet.addRow({
            NomeCliente: name,
            DataHoraFormatada: formattedDateForUser,
            DataHoraISO: requestedDate.toISOString(),
            TimestampAgendamento: new Date().toISOString(),
            Status: 'Confirmado',
            DuracaoMinutos: SERVICE_DURATION_MINUTES
        });
        
        return formattedDateForUser;
    } catch (error) {
        console.error('Erro ao salvar agendamento:', error);
        throw new Error('Não foi possível confirmar o agendamento');
    }
}

// --- FUNÇÕES AUXILIARES ---
function getPersonName(contexts) {
    if (!contexts || !Array.isArray(contexts)) return null;
    
    const contextWithName = contexts.find(ctx => 
        ctx.parameters && (
            ctx.parameters["person.original"] || 
            ctx.parameters["given-name"] ||
            ctx.parameters.nome
        )
    );
    
    if (!contextWithName) return null;
    
    return contextWithName.parameters["person.original"] || 
           contextWithName.parameters["given-name"] || 
           contextWithName.parameters.nome;
}

function createResponse(text, context = null, suggestions = []) {
    const payload = {
        fulfillmentMessages: [
            { text: { text: [text] } }
        ]
    };
    
    if (suggestions.length > 0) {
        payload.fulfillmentMessages.push({
            quickReplies: {
                title: "Você pode tentar:",
                quickReplies: suggestions
            }
        });
    }
    
    if (context) {
        payload.outputContexts = [{ 
            name: context, 
            lifespanCount: 2,
            parameters: {}
        }];
    }
    
    return payload;
}

// --- FUNÇÃO PRINCIPAL DE AGENDAMENTO ---
async function handleScheduling(name, dateParam, timeParam) {
    try {
        // 1. Validar entrada
        const dateTimeValidation = validateDateTime(dateParam, timeParam);
        if (!dateTimeValidation.valid) {
            return { 
                success: false, 
                message: dateTimeValidation.error,
                suggestions: ["Hoje às 14:00", "Amanhã às 10:30", "Segunda-feira às 15:00"]
            };
        }
        
        // 2. Parsear data e hora
        const requestedDate = parseDateTime(dateTimeValidation.dateValue, dateTimeValidation.timeValue);
        
        // 3. Verificar se não é no passado
        if (isInThePast(requestedDate)) {
            return {
                success: false,
                message: "Não posso agendar para uma data no passado. Por favor, escolha uma data futura.",
                suggestions: ["Hoje às 14:00", "Amanhã às 10:30"]
            };
        }
        
        // 4. Converter para horário de São Paulo
        const localDate = convertToSaoPauloTime(requestedDate);
        const dayOfWeek = localDate.getUTCDay();
        const hours = localDate.getUTCHours();
        const minutes = localDate.getUTCMinutes();
        const requestedTime = hours + minutes / 60;
        
        // 5. Verificar dia da semana
        if (!isDuringBusinessDays(dayOfWeek)) {
            const dayName = new Intl.DateTimeFormat('pt-BR', { 
                weekday: 'long', 
                timeZone: TIMEZONE 
            }).format(requestedDate);
            
            return {
                success: false,
                message: `Desculpe, não funcionamos ${dayName}. Funcionamos de segunda a sábado.`,
                suggestions: ["Segunda-feira às 14:00", "Terça-feira às 10:30"]
            };
        }
        
        // 6. Buscar configuração de horários
        const configRows = await getBusinessConfig();
        const dayConfig = configRows.find(row => row.DiaDaSemana == dayOfWeek);
        
        // 7. Verificar horário de funcionamento
        if (!isBusinessHours(requestedTime, dayConfig)) {
            const horarios = dayConfig ? 
                `${dayConfig.InicioManha} às ${dayConfig.FimManha}${dayConfig.InicioTarde ? ` e ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : ''}` :
                "nossos horários de funcionamento";
                
            return {
                success: false,
                message: `Desculpe, estamos fechados neste horário. Funcionamos ${horarios}.`,
                suggestions: ["10:00", "14:00", "16:00"]
            };
        }
        
        // 8. Verificar conflitos de agendamento
        const hasConflict = await checkExistingAppointments(requestedDate);
        if (hasConflict) {
            return {
                success: false,
                message: "Este horário já está ocupado ou muito próximo de outro agendamento. Por favor, escolha outro horário.",
                suggestions: ["30 minutos depois", "1 hora depois", "Outro dia"]
            };
        }
        
        // 9. Salvar agendamento
        const formattedDateForUser = await saveAppointment(name, requestedDate);
        
        return {
            success: true,
            message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}. Chegue com 5 minutos de antecedência. 💈`,
            suggestions: []
        };
        
    } catch (error) {
        console.error("Erro na lógica de agendamento:", error);
        return {
            success: false,
            message: "Houve um problema ao processar seu agendamento. Por favor, tente novamente com um formato como 'amanhã às 14:00'.",
            suggestions: ["Hoje às 14:00", "Amanhã às 10:00", "Segunda às 15:00"]
        };
    }
}

// --- MIDDLEWARES ---
app.use((req, res, next) => {
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    
    next();
});

// --- ROTAS ---
app.post("/webhook", async (request, response) => {
    let responsePayload;
    
    try {
        // Validar ambiente e requisição
        validateEnvironment();
        validateRequest(request);
        
        const intent = request.body.queryResult.intent.displayName;
        
        if (intent === "AgendarHorario") {
            const dateParam = request.body.queryResult.parameters.data;
            const timeParam = request.body.queryResult.parameters.hora;
            const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
            
            const result = await handleScheduling(personName, dateParam, timeParam);
            
            const currentSession = request.body.session;
            const context = result.success ? null : `${currentSession}/contexts/aguardando_agendamento`;
            
            responsePayload = createResponse(result.message, context, result.suggestions || []);
        } else {
            responsePayload = createResponse("Webhook contatado, mas a intenção não é reconhecida para agendamento.");
        }
        
    } catch (error) {
        console.error("Erro CRÍTICO no webhook:", error);
        responsePayload = createResponse(
            "Houve um erro interno. Por favor, tente novamente em alguns minutos.",
            null,
            ["Tentar novamente", "Falar com atendente"]
        );
    }
    
    response.json(responsePayload);
});

// Rota de health check
app.get("/health", (req, res) => {
    res.json({ 
        status: "ok", 
        timestamp: new Date().toISOString(),
        timezone: TIMEZONE 
    });
});

// Rota de teste (apenas para desenvolvimento)
if (process.env.NODE_ENV === 'development') {
    app.get("/test-config", async (req, res) => {
        try {
            const config = await getBusinessConfig();
            res.json({ config });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
}

// Tratamento de erros global
app.use((err, req, res, next) => {
    console.error('Erro não tratado:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
const listener = app.listen(PORT, () => {
    console.log(`🚀 Webhook da barbearia rodando na porta ${listener.address().port}`);
    console.log(`📅 Timezone configurada: ${TIMEZONE}`);
    console.log(`⏱️  Duração padrão do serviço: ${SERVICE_DURATION_MINUTES} minutos`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Recebido SIGTERM, fechando servidor...');
    listener.close(() => {
        console.log('Servidor fechado');
        process.exit(0);
    });
});
