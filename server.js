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
        console.log("🔄 Request completo recebido:");
        console.log("Headers:", request.headers);
        console.log("Body:", JSON.stringify(request.body, null, 2));
        
        validateRequest(request);
        const intent = request.body.queryResult.intent.displayName;
        const allParams = request.body.queryResult.parameters;
        
        console.log("🎯 Intent detectada:", intent);
        console.log("📋 Todos os parâmetros:", JSON.stringify(allParams, null, 2));
        
        let result;

        if (intent === "AgendarHorario") {
            // Procura o parâmetro de data com diferentes nomes possíveis
            const dateTimeParam = allParams['date-time'] || 
                                 allParams['datetime'] || 
                                 allParams['data-hora'] || 
                                 allParams['time'] ||
                                 allParams['horario'];
            
            console.log("🕐 Parâmetro de data/hora encontrado:", JSON.stringify(dateTimeParam, null, 2));
            
            if (!dateTimeParam) {
                console.log("❌ Nenhum parâmetro de data encontrado!");
                console.log("Parâmetros disponíveis:", Object.keys(allParams));
                return response.json(createResponse("Por favor, me informe quando você gostaria de agendar. Exemplo: 'sexta-feira às 9 da manhã' ou 'amanhã às 14 horas'."));
            }
            
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
    console.log("📅 Parâmetro date-time recebido:", JSON.stringify(dateTimeParam, null, 2));
    
    let requestedDate;
    
    // Para @sys.date-time do Dialogflow, a estrutura pode variar
    if (typeof dateTimeParam === 'string') {
        // Se for uma string ISO direta
        requestedDate = new Date(dateTimeParam);
    } else if (dateTimeParam && typeof dateTimeParam === 'object') {
        // Se for um objeto, procura pelas propriedades comuns do @sys.date-time
        if (dateTimeParam.date_time) {
            requestedDate = new Date(dateTimeParam.date_time);
        } else if (dateTimeParam.startDateTime) {
            requestedDate = new Date(dateTimeParam.startDateTime);
        } else if (dateTimeParam.start) {
            requestedDate = new Date(dateTimeParam.start);
        } else if (dateTimeParam.endDateTime) {
            requestedDate = new Date(dateTimeParam.endDateTime);
        } else {
            // Tenta converter o objeto inteiro para string e depois para data
            const dateStr = Object.values(dateTimeParam)[0];
            if (dateStr) {
                requestedDate = new Date(dateStr);
            }
        }
    }

    // Se ainda não conseguiu extrair a data, tenta outras abordagens
    if (!requestedDate || isNaN(requestedDate.getTime())) {
        console.log("❌ Tentando abordagem alternativa para extrair data...");
        
        // Se o parâmetro tem uma propriedade que parece ser uma data ISO
        const dateStr = JSON.stringify(dateTimeParam);
        const isoDateMatch = dateStr.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        
        if (isoDateMatch) {
            requestedDate = new Date(isoDateMatch[1]);
            console.log("✅ Data extraída via regex:", isoDateMatch[1]);
        }
    }

    if (!requestedDate || isNaN(requestedDate.getTime())) {
        console.log("❌ Não foi possível extrair data válida do parâmetro");
        return { 
            success: false, 
            message: "Não consegui entender a data e hora. Por favor, tente com um formato mais específico como 'sexta-feira às 9 da manhã' ou 'amanhã às 14 horas'." 
        };
    }

    console.log("✅ Data processada com sucesso:", requestedDate.toISOString());

    const now = new Date();
    if (requestedDate <= now) {
        console.log("❌ Data no passado:", requestedDate, "vs agora:", now);
        return { success: false, message: "Não é possível agendar para um horário que já passou. Por favor, escolha uma data e hora futura." };
    }
    
    try {
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
        
        const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { 
            dateStyle: 'full', 
            timeStyle: 'short', 
            timeZone: TIMEZONE 
        }).format(requestedDate);
        
        await saveAppointment(name, requestedDate, scheduleSheet);
        
        return { success: true, message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.` };
    } catch (error) {
        console.error("Erro no agendamento:", error);
        return { success: false, message: "Erro ao processar o agendamento. Tente novamente." };
    }
}

// --- FUNÇÕES UTILITÁRIAS ---

async function checkBusinessHours(date, configSheet) {
    try {
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
        
        const dayName = new Intl.DateTimeFormat('pt-BR', { 
            weekday: 'long', 
            timeZone: TIMEZONE 
        }).format(date);
        
        const configRows = await configSheet.getRows();
        const dayConfig = configRows.find(row => parseInt(row.DiaDaSemana) === dayOfWeek);

        if (!dayConfig || !dayConfig.InicioManha) {
            return { isOpen: false, dayName };
        }

        const timeToDecimal = (str) => {
            if (!str) return 0;
            const [hours, minutes] = str.split(':').map(Number);
            return hours + (minutes || 0) / 60;
        };
        
        const inicioManha = timeToDecimal(dayConfig.InicioManha);
        const fimManha = timeToDecimal(dayConfig.FimManha);

        if (requestedTime >= inicioManha && requestedTime < fimManha) {
            return { isOpen: true, dayName };
        }
        
        if (dayConfig.InicioTarde && dayConfig.FimTarde) {
            const inicioTarde = timeToDecimal(dayConfig.InicioTarde);
            const fimTarde = timeToDecimal(dayConfig.FimTarde);
            if (requestedTime >= inicioTarde && requestedTime < fimTarde) {
                return { isOpen: true, dayName };
            }
        }
        
        return { isOpen: false, dayName };
    } catch (error) {
        console.error("Erro ao verificar horário de funcionamento:", error);
        return { isOpen: false, dayName: "desconhecido" };
    }
}

function validateEnvironment() {
    const requiredEnvVars = ['GOOGLE_CREDENTIALS', 'SHEET_ID'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        console.error(`❌ Variáveis de ambiente faltando: ${missingVars.join(', ')}`);
        process.exit(1);
    }
    
    try {
        JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (error) {
        console.error('❌ GOOGLE_CREDENTIALS não é um JSON válido');
        process.exit(1);
    }
    
    console.log('✅ Variáveis de ambiente configuradas corretamente');
}

function validateRequest(request) {
    if (!request.body) {
        throw new Error("Body da requisição está vazio");
    }
    
    if (!request.body.queryResult) {
        throw new Error("queryResult não encontrado no body");
    }
    
    if (!request.body.queryResult.intent) {
        throw new Error("Intent não encontrada no queryResult");
    }
    
    if (!request.body.session) {
        throw new Error("Session não encontrada no body");
    }
}

async function checkConflicts(requestedDate, scheduleSheet) {
    try {
        const rows = await scheduleSheet.getRows();
        const serviceDurationMs = SERVICE_DURATION_MINUTES * 60 * 1000;
        const requestedStart = requestedDate.getTime();
        const requestedEnd = requestedStart + serviceDurationMs;

        for (const row of rows) {
            if (!row.DataHora) continue;
            
            const existingDate = new Date(row.DataHora);
            if (isNaN(existingDate.getTime())) continue;
            
            const existingStart = existingDate.getTime();
            const existingEnd = existingStart + serviceDurationMs;

            // Verifica se há sobreposição de horários
            const hasOverlap = (requestedStart < existingEnd) && (requestedEnd > existingStart);
            if (hasOverlap) {
                return true;
            }
        }
        
        return false;
    } catch (error) {
        console.error("Erro ao verificar conflitos:", error);
        return true; // Em caso de erro, assume conflito por segurança
    }
}

async function saveAppointment(name, requestedDate, scheduleSheet) {
    try {
        const isoDate = requestedDate.toISOString();
        const formattedDate = new Intl.DateTimeFormat('pt-BR', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: TIMEZONE
        }).format(requestedDate);

        await scheduleSheet.addRow({
            Nome: name,
            DataHora: isoDate,
            DataFormatada: formattedDate,
            Status: 'Agendado',
            Criado: new Date().toISOString()
        });
        
        console.log(`✅ Agendamento salvo: ${name} - ${formattedDate}`);
    } catch (error) {
        console.error("Erro ao salvar agendamento:", error);
        throw error;
    }
}

function getPersonName(contexts) {
    if (!contexts || !Array.isArray(contexts)) {
        return null;
    }
    
    for (const context of contexts) {
        if (context.name && context.name.includes('person-context')) {
            if (context.parameters && context.parameters.name) {
                return context.parameters.name;
            }
        }
        
        // Fallback: procura em qualquer contexto por um parâmetro de nome
        if (context.parameters) {
            const nameFields = ['name', 'nome', 'person-name', 'given-name'];
            for (const field of nameFields) {
                if (context.parameters[field]) {
                    return context.parameters[field];
                }
            }
        }
    }
    
    return null;
}

function createResponse(text, context = null) {
    const response = {
        fulfillmentText: text,
        fulfillmentMessages: [
            {
                text: {
                    text: [text]
                }
            }
        ]
    };
    
    if (context) {
        response.outputContexts = [
            {
                name: context,
                lifespanCount: 5,
                parameters: {}
            }
        ];
    }
    
    return response;
}

// Endpoint para debug mais detalhado - ver EXATAMENTE o que chega
app.post("/debug-detailed", (req, res) => {
    console.log("\n=== DEBUG DETALHADO ===");
    console.log("🔍 Request Headers:", JSON.stringify(req.headers, null, 2));
    console.log("🔍 Request Body:", JSON.stringify(req.body, null, 2));
    
    if (req.body.queryResult) {
        console.log("🔍 Query Result:", JSON.stringify(req.body.queryResult, null, 2));
        console.log("🔍 Parameters:", JSON.stringify(req.body.queryResult.parameters, null, 2));
        console.log("🔍 Query Text:", req.body.queryResult.queryText);
        console.log("🔍 Intent:", req.body.queryResult.intent?.displayName);
        
        // Verifica especificamente o parâmetro date-time
        const dateTimeParam = req.body.queryResult.parameters?.['date-time'];
        if (dateTimeParam) {
            console.log("🔍 ENCONTROU date-time:", JSON.stringify(dateTimeParam, null, 2));
            console.log("🔍 Tipo do date-time:", typeof dateTimeParam);
        } else {
            console.log("❌ NÃO ENCONTROU parâmetro date-time");
            console.log("📋 Parâmetros disponíveis:", Object.keys(req.body.queryResult.parameters || {}));
        }
    }
    
    console.log("=== FIM DEBUG ===\n");
    
    res.json({
        message: "Debug completo no console",
        hasDateTime: !!req.body.queryResult?.parameters?.['date-time'],
        allParameters: req.body.queryResult?.parameters || {},
        queryText: req.body.queryResult?.queryText,
        intent: req.body.queryResult?.intent?.displayName
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        timezone: TIMEZONE 
    });
});

// Endpoint para testar conexão com Google Sheets
app.get('/test-sheets', async (req, res) => {
    try {
        const doc = new GoogleSpreadsheet(sheetId);
        await doc.useServiceAccountAuth(creds);
        await doc.loadInfo();
        
        res.json({
            success: true,
            title: doc.title,
            sheets: Object.keys(doc.sheetsByTitle)
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`);
    console.log(`📋 Health check disponível em: http://localhost:${PORT}/health`);
    console.log(`🧪 Teste de planilhas em: http://localhost:${PORT}/test-sheets`);
    console.log(`🐛 Debug detalhado em: http://localhost:${PORT}/debug-detailed`);
});
