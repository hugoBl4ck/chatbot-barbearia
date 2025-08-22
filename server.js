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
});
