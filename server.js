// Importar as bibliotecas necessárias
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- CONFIGURAÇÃO DA PLANILHA E CREDENCIAIS ---
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
const sheetId = process.env.SHEET_ID;
const TIMEZONE = 'America/Buenos_Aires'; // Mesmo timezone do Dialogflow (UTC-3)
const SERVICE_DURATION_MINUTES = 30; // Duração padrão do serviço
const TIMEZONE_OFFSET = -3; // Offset para América/Buenos Aires (UTC-3 - igual São Paulo)

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

function validateDateTime(dateParam, timeParam, originalQuery = '') {
    console.log('=== VALIDAÇÃO ===');
    console.log('dateParam:', JSON.stringify(dateParam));
    console.log('timeParam:', JSON.stringify(timeParam));
    console.log('originalQuery:', originalQuery);
    
    // Se não temos parâmetros estruturados, tentar extrair da query original
    if ((!dateParam || !timeParam) && originalQuery) {
        console.log('Tentando extrair da query original...');
        const extracted = extractFromQuery(originalQuery);
        if (extracted.date && extracted.time) {
            return {
                valid: true,
                dateValue: extracted.date,
                timeValue: extracted.time,
                isTextFormat: true,
                source: 'query'
            };
        }
    }
    
    // Verificar se temos parâmetros válidos
    if (!dateParam || !timeParam || 
        dateParam === '' || timeParam === '' ||
        dateParam === 'Enter value' || timeParam === 'Enter value') {
        return { valid: false, error: "Por favor, informe uma data e hora completas." };
    }
    
    // Se chegarem como string (texto)
    if (typeof dateParam === 'string' && typeof timeParam === 'string') {
        return { 
            valid: true, 
            dateValue: dateParam, 
            timeValue: timeParam,
            isTextFormat: true,
            source: 'params'
        };
    }
    
    // Se chegarem como objetos (formato ISO)
    const dateValue = dateParam?.start || dateParam;
    const timeValue = timeParam?.start || timeParam;
    
    if (!dateValue || !timeValue) {
        return { valid: false, error: "Formato de data/hora inválido." };
    }
    
    return { 
        valid: true, 
        dateValue, 
        timeValue, 
        isTextFormat: false,
        source: 'structured'
    };
}

function extractFromQuery(query) {
    console.log('=== EXTRAINDO DA QUERY ===');
    console.log('Query completa:', query);
    
    const result = { date: null, time: null };
    const queryLower = query.toLowerCase().trim();
    
    // Padrões completos primeiro - casos como "amanhã às 9h", "hoje às 14:00"
    const fullPatterns = [
        // Padrão: "amanhã às 9h"
        /(hoje|amanhã|amanha|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)(?:-feira)?\s+(?:às?|as)\s+(\d{1,2})h?(\d{2})?/,
        // Padrão: "amanhã às 14:00"  
        /(hoje|amanhã|amanha|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)(?:-feira)?\s+(?:às?|as)\s+(\d{1,2}):(\d{2})/,
        // Padrão: "segunda às 3 da tarde"
        /(hoje|amanhã|amanha|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)(?:-feira)?\s+(?:às?|as)\s+(\d{1,2})\s+da\s+(manhã|manha|tarde|noite)/
    ];
    
    for (const pattern of fullPatterns) {
        const match = queryLower.match(pattern);
        if (match) {
            console.log('Match encontrado:', match);
            
            // Extrair data
            let dateWord = match[1];
            if (dateWord === 'amanha') dateWord = 'amanhã';
            result.date = dateWord;
            
            // Extrair hora
            let hour = parseInt(match[2]);
            let minute = 0;
            
            if (match[3] && !isNaN(match[3])) {
                // Formato HH:MM ou HHhMM
                minute = parseInt(match[3]);
            } else if (match[4]) {
                // Caso "3 da tarde"
                const period = match[4];
                if (period === 'tarde' && hour < 12) {
                    hour += 12;
                } else if (period === 'noite' && hour < 12) {
                    hour += 12;
                }
            }
            
            result.time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            console.log('Resultado extração completa:', result);
            return result;
        }
    }
    
    // Fallback: extrair separadamente
    console.log('Fallback: extração separada');
    
    // Extrair data
    const dateWords = ['hoje', 'amanhã', 'amanha', 'segunda', 'terça', 'terca', 'quarta', 'quinta', 'sexta', 'sábado', 'sabado'];
    for (const word of dateWords) {
        if (queryLower.includes(word)) {
            result.date = word === 'amanha' ? 'amanhã' : word;
            break;
        }
    }
    
    // Extrair hora
    const hourPatterns = [
        /(\d{1,2}):(\d{2})/,           // 14:00
        /(\d{1,2})h(\d{2})?/,          // 9h, 9h30
        /(\d{1,2})\s*horas?/,          // 9 horas
        /às?\s+(\d{1,2})/,             // às 9
    ];
    
    for (const pattern of hourPatterns) {
        const match = queryLower.match(pattern);
        if (match) {
            const hour = parseInt(match[1]);
            const minute = match[2] ? parseInt(match[2]) : 0;
            result.time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            break;
        }
    }
    
    // Casos especiais de período
    if (!result.time) {
        if (queryLower.includes('manhã') || queryLower.includes('manha')) {
            result.time = '09:00';
        } else if (queryLower.includes('tarde')) {
            result.time = '14:00';
        } else if (queryLower.includes('noite')) {
            result.time = '19:00';
        }
    }
    
    console.log('Resultado final extração:', result);
    return result;
}

// --- UTILITÁRIOS DE DATA/HORA ---
function parseDateTime(dateValue, timeValue, isTextFormat = false) {
    try {
        if (isTextFormat) {
            // Se chegaram como texto, usar interpretação inteligente
            return parseTextDateTime(dateValue, timeValue);
        }
        
        // Parsing normal para formato ISO
        const datePart = dateValue.split('T')[0];
        let timePart;
        if (timeValue.includes('T')) {
            timePart = timeValue.split('T')[1];
        } else {
            timePart = timeValue;
        }
        
        timePart = timePart.split(/[+\-Z]/)[0];
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

function parseTextDateTime(dateText, timeText) {
    console.log('=== PARSEANDO TEXTO ===');
    console.log('Data:', dateText);
    console.log('Hora:', timeText);
    
    const now = new Date();
    let targetDate = new Date();
    
    // Interpretar data
    const dateTextLower = dateText.toLowerCase();
    
    if (dateTextLower.includes('hoje')) {
        // Usar data atual
        targetDate = new Date(now);
    } else if (dateTextLower.includes('amanhã') || dateTextLower.includes('amanha')) {
        targetDate = new Date(now);
        targetDate.setDate(now.getDate() + 1);
    } else if (dateTextLower.includes('segunda')) {
        targetDate = getNextWeekday(1);
    } else if (dateTextLower.includes('terça') || dateTextLower.includes('terca')) {
        targetDate = getNextWeekday(2);
    } else if (dateTextLower.includes('quarta')) {
        targetDate = getNextWeekday(3);
    } else if (dateTextLower.includes('quinta')) {
        targetDate = getNextWeekday(4);
    } else if (dateTextLower.includes('sexta')) {
        targetDate = getNextWeekday(5);
    } else if (dateTextLower.includes('sábado') || dateTextLower.includes('sabado')) {
        targetDate = getNextWeekday(6);
    } else {
        // Tentar interpretar como data ISO
        const isoMatch = dateText.match(/\d{4}-\d{2}-\d{2}/);
        if (isoMatch) {
            targetDate = new Date(isoMatch[0]);
        }
    }
    
    // Interpretar hora
    let hours = 0, minutes = 0;
    const timeTextLower = timeText.toLowerCase();
    
    // Primeiro, tentar padrões específicos
    const hourMatch = timeText.match(/(\d{1,2}):(\d{2})/);
    if (hourMatch) {
        hours = parseInt(hourMatch[1]);
        minutes = parseInt(hourMatch[2]);
    } else {
        const simpleHourMatch = timeText.match(/(\d{1,2})h?(\d{2})?/);
        if (simpleHourMatch) {
            hours = parseInt(simpleHourMatch[1]);
            minutes = simpleHourMatch[2] ? parseInt(simpleHourMatch[2]) : 0;
        } else if (timeTextLower.includes('manhã') || timeTextLower.includes('manha')) {
            hours = 9;
        } else if (timeTextLower.includes('tarde')) {
            // Verificar se tem número específico
            if (timeTextLower.includes('3') || timeTextLower.includes('três') || timeTextLower.includes('tres')) {
                hours = 15;
            } else if (timeTextLower.includes('2') || timeTextLower.includes('duas')) {
                hours = 14;
            } else if (timeTextLower.includes('4') || timeTextLower.includes('quatro')) {
                hours = 16;
            } else if (timeTextLower.includes('5') || timeTextLower.includes('cinco')) {
                hours = 17;
            } else {
                hours = 14; // Padrão tarde
            }
        } else if (timeTextLower.includes('noite')) {
            hours = 19;
        }
    }
    
    // Definir a hora na data
    targetDate.setHours(hours, minutes, 0, 0);
    
    console.log('Data final interpretada:', {
        original: { date: dateText, time: timeText },
        parsed: targetDate.toString(),
        iso: targetDate.toISOString(),
        hours, minutes
    });
    
    return targetDate;
}

function getNextWeekday(targetDay) {
    const now = new Date();
    const currentDay = now.getDay();
    let daysUntilTarget = targetDay - currentDay;
    
    if (daysUntilTarget <= 0) {
        daysUntilTarget += 7; // Próxima semana
    }
    
    const result = new Date(now);
    result.setDate(now.getDate() + daysUntilTarget);
    return result;
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
async function handleScheduling(name, dateParam, timeParam, request) {
    try {
        // === LOGS DE DEBUG ===
        console.log('\n=== DEBUG AGENDAMENTO ===');
        console.log('Nome:', name);
        console.log('dateParam RAW:', JSON.stringify(dateParam, null, 2));
        console.log('timeParam RAW:', JSON.stringify(timeParam, null, 2));
        console.log('dateParam type:', typeof dateParam, Array.isArray(dateParam) ? '[ARRAY]' : '[NOT ARRAY]');
        console.log('timeParam type:', typeof timeParam, Array.isArray(timeParam) ? '[ARRAY]' : '[NOT ARRAY]');
        
        // 1. Validar entrada
        const originalQuery = request.body.queryResult?.queryText || '';
        console.log('Query original:', originalQuery);
        
        const dateTimeValidation = validateDateTime(dateParam, timeParam, originalQuery);
        console.log('Resultado validação:', dateTimeValidation);
        if (!dateTimeValidation.valid) {
            return { 
                success: false, 
                message: dateTimeValidation.error,
                suggestions: ["Hoje às 14:00", "Amanhã às 10:30", "Segunda-feira às 15:00"]
            };
        }
        
        // 2. Parsear data e hora
        const requestedDate = parseDateTime(
            dateTimeValidation.dateValue, 
            dateTimeValidation.timeValue,
            dateTimeValidation.isTextFormat
        );
        console.log('Data parseada (UTC):', requestedDate.toISOString());
        console.log('Data parseada (Local):', requestedDate.toString());
        
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
        
        console.log('Data convertida SP:', localDate.toISOString());
        console.log('Dia da semana:', dayOfWeek, '(0=Dom, 1=Seg, etc.)');
        console.log('Hora decimal:', requestedTime, '(', hours, ':', minutes, ')');
        console.log('============================\n');
        
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
        
        console.log('Configuração do dia encontrada:', dayConfig ? {
            DiaDaSemana: dayConfig.DiaDaSemana,
            InicioManha: dayConfig.InicioManha,
            FimManha: dayConfig.FimManha,
            InicioTarde: dayConfig.InicioTarde,
            FimTarde: dayConfig.FimTarde
        } : 'NENHUMA CONFIGURAÇÃO ENCONTRADA');
        
        // 7. Verificar horário de funcionamento
        const isValidTime = isBusinessHours(requestedTime, dayConfig);
        console.log('Horário válido?', isValidTime);
        
        if (!isValidTime) {
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
            
            const result = await handleScheduling(personName, dateParam, timeParam, request);
            
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
