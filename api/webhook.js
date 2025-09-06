// =================================================================
// WEBHOOK COM DAYJS - SOLUÇÃO MAIS ROBUSTA
// =================================================================

const express = require("express");
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
const customParseFormat = require('dayjs/plugin/customParseFormat');
require('dayjs/locale/pt-br');

// Configurar dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.locale('pt-br');

const app = express();
app.use(express.json());

const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    timezone: 'America/Sao_Paulo',
    collections: { 
        schedules: 'Agendamentos', 
        config: 'Horarios',
        services: 'Servicos'
    }
};

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}

// Função para parsear texto em data
function parseDateTime(text) {
    const now = dayjs().tz(CONFIG.timezone);
    const tomorrow = now.add(1, 'day');
    
    // Normalizar texto
    text = text.toLowerCase().trim();
    
    // Mapeamento dos dias da semana
    const weekDays = {
        'domingo': 0, 'dom': 0,
        'segunda': 1, 'seg': 1, 'segunda-feira': 1,
        'terça': 2, 'ter': 2, 'terca': 2, 'terça-feira': 2, 'terca-feira': 2,
        'quarta': 3, 'qua': 3, 'quarta-feira': 3,
        'quinta': 4, 'qui': 4, 'quinta-feira': 4,
        'sexta': 5, 'sex': 5, 'sexta-feira': 5,
        'sábado': 6, 'sab': 6, 'sabado': 6
    };
    
    // Função auxiliar para encontrar o próximo dia da semana
    const getNextWeekday = (targetDay, hour, minute) => {
        const currentDay = now.day();
        let daysToAdd = targetDay - currentDay;
        
        // Se é o mesmo dia da semana, verifica se o horário já passou
        if (daysToAdd === 0) {
            const timeToday = now.hour(hour).minute(minute).second(0).millisecond(0);
            if (timeToday.isAfter(now)) {
                // Horário ainda não passou hoje
                return timeToday;
            } else {
                // Horário já passou, vai para a próxima semana
                daysToAdd = 7;
            }
        } else if (daysToAdd < 0) {
            // Dia da semana já passou esta semana
            daysToAdd += 7;
        }
        
        return now.add(daysToAdd, 'day').hour(hour).minute(minute).second(0).millisecond(0);
    };
    
    // Padrões de reconhecimento
    const patterns = [
        // "próxima quarta às 10h", "proxima terça as 18h"
        {
            regex: /pr[oó]xim[ao]\s+(\w+(?:-feira)?)\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?/,
            handler: (match) => {
                const dayName = match[1];
                const hour = parseInt(match[2]);
                const minute = parseInt(match[3] || '0');
                
                if (weekDays.hasOwnProperty(dayName)) {
                    const targetDay = weekDays[dayName];
                    // Para "próxima", sempre adiciona pelo menos uma semana
                    const currentDay = now.day();
                    let daysToAdd = targetDay - currentDay;
                    if (daysToAdd <= 0) {
                        daysToAdd += 7;
                    } else {
                        // Se é o mesmo dia e o horário ainda não passou, vai para próxima semana mesmo assim
                        daysToAdd += 7;
                    }
                    return now.add(daysToAdd, 'day').hour(hour).minute(minute).second(0).millisecond(0);
                }
                return null;
            }
        },
        // "quarta às 10h", "terça as 18h", "segunda as 9h"
        {
            regex: /^(\w+(?:-feira)?)\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?$/,
            handler: (match) => {
                const dayName = match[1];
                const hour = parseInt(match[2]);
                const minute = parseInt(match[3] || '0');
                
                if (weekDays.hasOwnProperty(dayName)) {
                    const targetDay = weekDays[dayName];
                    return getNextWeekday(targetDay, hour, minute);
                }
                return null;
            }
        },
        // "na quarta às 10h", "na terça as 18h"
        {
            regex: /na\s+(\w+(?:-feira)?)\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?/,
            handler: (match) => {
                const dayName = match[1];
                const hour = parseInt(match[2]);
                const minute = parseInt(match[3] || '0');
                
                if (weekDays.hasOwnProperty(dayName)) {
                    const targetDay = weekDays[dayName];
                    return getNextWeekday(targetDay, hour, minute);
                }
                return null;
            }
        },
        // "amanhã às 16h", "amanha as 16:00"
        {
            regex: /(?:amanh[aã]|amanha)\s+(?:[aà]s?)\s+(\d{1,2})(?::(\d{2}))?h?/,
            handler: (match) => {
                const hour = parseInt(match[1]);
                const minute = parseInt(match[2] || '0');
                return tomorrow.hour(hour).minute(minute).second(0).millisecond(0);
            }
        },
        // "hoje às 16h"
        {
            regex: /hoje\s+(?:[aà]s?)\s+(\d{1,2})(?::(\d{2}))?h?/,
            handler: (match) => {
                const hour = parseInt(match[1]);
                const minute = parseInt(match[2] || '0');
                return now.hour(hour).minute(minute).second(0).millisecond(0);
            }
        },
        // "16h", "16:30"
        {
            regex: /^(\d{1,2})(?::(\d{2}))?h?$/,
            handler: (match) => {
                const hour = parseInt(match[1]);
                const minute = parseInt(match[2] || '0');
                let date = now.hour(hour).minute(minute).second(0).millisecond(0);
                // Se o horário já passou hoje, assumir que é amanhã
                if (date.isBefore(now)) {
                    date = date.add(1, 'day');
                }
                return date;
            }
        },
        // "31/08 às 16h", "31/08/2025 16:30"
        {
            regex: /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?/,
            handler: (match) => {
                const day = parseInt(match[1]);
                const month = parseInt(match[2]);
                const year = parseInt(match[3] || now.year());
                const hour = parseInt(match[4]);
                const minute = parseInt(match[5] || '0');
                return dayjs().tz(CONFIG.timezone).year(year).month(month - 1).date(day).hour(hour).minute(minute).second(0).millisecond(0);
            }
        }
    ];

    // Testar cada padrão
    for (const pattern of patterns) {
        const match = text.match(pattern.regex);
        if (match) {
            const result = pattern.handler(match);
            if (result) {
                return result;
            }
        }
    }
    
    
    for (const pattern of patterns) {
        const match = text.match(pattern.regex);
        if (match) {
            return pattern.handler(match);
        }
    }
    
    return null;
}

app.post("/api/webhook", async (request, response) => {
    const body = request.body;
    console.log("\n🔄 === NOVO REQUEST WEBHOOK (LANDBOT) ===", JSON.stringify(body, null, 2));

    try {
        const { intent, nome, telefone, data_hora_texto, servicoId } = body;
        const db = admin.firestore();
        let resultPayload;

        if (intent === 'agendarHorario') {
            const parsedDate = parseDateTime(data_hora_texto);
            
            if (!parsedDate) {
                resultPayload = { success: false, message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou '16:30'." };
            } else {
                console.log("📅 Data parseada:", parsedDate.format('DD/MM/YYYY HH:mm'));
                console.log("📅 Em UTC:", parsedDate.utc().format());
                
                // Converter para objeto Date JavaScript para uso no resto do código
                const dateForStorage = parsedDate.utc().toDate();
                // CORREÇÃO: criar uma data local "fake" só para validação de horário
                const dateForValidation = new Date(
                    parsedDate.year(),
                    parsedDate.month(),
                    parsedDate.date(),
                    parsedDate.hour(),
                    parsedDate.minute(),
                    0,
                    0
                );

                console.log("📅 Data para storage (UTC):", dateForStorage.toISOString());
                console.log("📅 Data para validação (local):", dateForValidation.toString());

                const personInfo = { name: nome, phone: telefone };
                resultPayload = await handleScheduling(personInfo, dateForStorage, dateForValidation, servicoId, db);
            }
        } else if (intent === 'cancelarHorario') {
             const personInfo = { phone: telefone };
             resultPayload = await handleCancellation(personInfo, db);
        } else {
            resultPayload = { success: false, message: "Desculpe, não entendi sua intenção." };
        }
        
        const responseData = { status: resultPayload.success ? 'success' : 'error', message: resultPayload.message };
        console.log(`📤 RESPOSTA ENVIADA:`, JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(500).json({ status: 'error', message: "Desculpe, ocorreu um erro interno." });
    }
});

// Resto das funções permanecem iguais à versão anterior
async function handleScheduling(personInfo, requestedDate, localTime, servicoId, db) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Faltam seus dados pessoais." };
    if (!servicoId) return { success: false, message: "Você precisa selecionar um serviço." };
    if (requestedDate.getTime() <= new Date().getTime()) return { success: false, message: "Não é possível agendar no passado." };

    const servicoRef = db.collection(CONFIG.collections.services).doc(servicoId);
    const servicoSnap = await servicoRef.get();
    if (!servicoSnap.exists) return { success: false, message: "O serviço não foi encontrado." };
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };

    const businessHoursCheck = await checkBusinessHours(localTime, servico.duracaoMinutos, db);
    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(requestedDate, servico.duracaoMinutos, db);
    if (hasConflict) {
        console.log("⚠️ Conflito detectado, buscando horários alternativos...");
        const suggestions = await getAvailableSlots(requestedDate, servico.duracaoMinutos, db);
        return { success: false, message: suggestions };
    }

    await saveAppointment(personInfo, requestedDate, servico, db);
    
    const formattedDateForUser = dayjs(requestedDate).tz(CONFIG.timezone).format('dddd, DD [de] MMMM [às] HH:mm');
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` };
}

async function checkBusinessHours(date, duracaoMinutos, db) {
    const dayOfWeek = date.getDay();
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { 
        if (!str) return null; 
        const [h, m] = str.split(':').map(Number); 
        return (h * 60) + (m || 0); 
    };
    
    console.log("🕐 Verificando horário comercial para:", date.toString());
    console.log("🕐 Configuração do dia:", dayConfig);
    
    const requestedStartMinutes = date.getHours() * 60 + date.getMinutes();
    const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;
    
    console.log(`🕐 Horário solicitado: ${Math.floor(requestedStartMinutes/60)}:${String(requestedStartMinutes%60).padStart(2,'0')} - ${Math.floor(requestedEndMinutes/60)}:${String(requestedEndMinutes%60).padStart(2,'0')}`);

    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);

    const fitsInMorning = (morningStart !== null && morningEnd !== null) && 
                         (requestedStartMinutes >= morningStart && requestedEndMinutes <= morningEnd);
    const fitsInAfternoon = (afternoonStart !== null && afternoonEnd !== null) && 
                           (requestedStartMinutes >= afternoonStart && requestedEndMinutes <= afternoonEnd);

    if (fitsInMorning || fitsInAfternoon) {
        return { isOpen: true };
    } else {
        const morning = dayConfig.InicioManha ? `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}` : '';
        const afternoon = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
        return { isOpen: false, message: `Nosso horário de funcionamento é ${morning}${afternoon}. O serviço solicitado não se encaixa nesse período.` };
    }
}

async function getAvailableSlots(requestedDate, duracaoMinutos, db) {
    try {
        const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
        const today = requestedDateDayjs;
        const tomorrow = requestedDateDayjs.add(1, 'day');

        // Buscar slots do dia solicitado
        let availableSlots = await findAvailableSlotsForDay(today, duracaoMinutos, db);
        
        if (availableSlots.length > 0) {
            const dateStr = today.format('DD/MM/YYYY');
            const slotsText = availableSlots.slice(0, 3).join(', '); // Máximo 3 sugestões
            return `Este horário já está ocupado. Que tal um destes horários disponíveis para ${dateStr}? ${slotsText}`;
        }
        
        // Se não há slots hoje, buscar amanhã
        availableSlots = await findAvailableSlotsForDay(tomorrow, duracaoMinutos, db);
        
        if (availableSlots.length > 0) {
            const dateStr = tomorrow.format('DD/MM/YYYY');
            const slotsText = availableSlots.slice(0, 3).join(', '); // Máximo 3 sugestões
            return `Este horário já está ocupado e não há mais vagas hoje. Que tal agendar para ${dateStr}? Horários disponíveis: ${slotsText}`;
        }
        
        return "Este horário já está ocupado. Infelizmente não encontrei horários disponíveis para hoje nem amanhã. Tente outro dia.";
        
    } catch (error) {
        console.error("Erro ao buscar horários disponíveis:", error);
        return "Este horário já está ocupado. Tente outro horário.";
    }
}

async function findAvailableSlotsForDay(dayDate, duracaoMinutos, db) {
    const dayOfWeek = dayDate.day();
    
    // Buscar configuração do dia
    const docRef = db.collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    if (!docSnap.exists) return [];
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { 
        if (!str) return null; 
        const [h, m] = str.split(':').map(Number); 
        return (h * 60) + (m || 0); 
    };

    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    
    // Buscar agendamentos existentes do dia
    const startOfDay = dayDate.startOf('day');
    const endOfDay = dayDate.endOf('day');
    
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('Status', '==', 'Agendado');
        
    
    const snapshot = await q.get();
    
    // Criar array de horários ocupados
    const busySlots = [];
    snapshot.docs.forEach(doc => {
        const data = doc.data();
        const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
        const endTime = startTime.add(data.duracaoMinutos || 60, 'minutes');
        busySlots.push({
            start: startTime.hour() * 60 + startTime.minute(),
            end: endTime.hour() * 60 + endTime.minute()
        });
    });
    
    // Gerar slots disponíveis
    const availableSlots = [];
    const currentTime = dayjs().tz(CONFIG.timezone);
    const isToday = dayDate.isSame(currentTime, 'day');
    
    // Função para adicionar slots de um período
    const addSlotsFromPeriod = (startMinutes, endMinutes) => {
        if (startMinutes === null || endMinutes === null) return;
        
        for (let time = startMinutes; time + duracaoMinutos <= endMinutes; time += 30) {
            const slotDate = dayDate.hour(Math.floor(time / 60)).minute(time % 60);
            
            // Se é hoje, só oferece horários futuros (com 1h de antecedência mínima)
            if (isToday && slotDate.isBefore(currentTime.add(1, 'hour'))) {
                continue;
            }
            
            // Verificar se há conflito
            const hasConflict = busySlots.some(busy => 
                (time < busy.end && (time + duracaoMinutos) > busy.start)
            );
            
            if (!hasConflict) {
                availableSlots.push(slotDate.format('HH:mm'));
            }
        }
    };
    
    // Adicionar slots da manhã
    addSlotsFromPeriod(morningStart, morningEnd);
    
    // Adicionar slots da tarde
    addSlotsFromPeriod(afternoonStart, afternoonEnd);
    
    return availableSlots;
}

async function handleCancellation(personInfo, db) {
    if (!personInfo.phone) return { success: false, message: "Para cancelar, preciso do seu telefone." };
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString());
    const snapshot = await q.get();
    if (snapshot.empty) return { success: false, message: `Não encontrei nenhum agendamento futuro no seu telefone.` };
    
    let count = 0;
    for (const doc of snapshot.docs) { 
        await doc.ref.update({ Status: 'Cancelado' }); 
        count++; 
    }
    return { success: true, message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.` };
}

async function checkConflicts(requestedDate, duracaoMinutos, db) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    
    const searchStart = new Date(requestedStart - 2 * 60 * 60 * 1000);
    const searchEnd = new Date(requestedStart + 2 * 60 * 60 * 1000);
    
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const q = schedulesRef
        .where('DataHoraISO', '>=', searchStart.toISOString())
        .where('DataHoraISO', '<=', searchEnd.toISOString());
    
    const snapshot = await q.get();
    
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        
        // MUDANÇA: Só considerar conflito se status for 'Agendado'
        if (existingData.Status !== 'Agendado') {
            continue;
        }
        
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingEnd = existingStart + ((existingData.duracaoMinutos || 60) * 60 * 1000);
        
        if (requestedStart < existingEnd && requestedEnd > existingStart) { 
            return true; 
        }
    }
    return false;
}

async function saveAppointment(personInfo, requestedDate, servico, db) {
    // NOVA LÓGICA: Verificar se existe agendamento cancelado no mesmo horário
    const schedulesRef = db.collection(CONFIG.collections.schedules);
    const exactTimeQuery = schedulesRef.where('DataHoraISO', '==', requestedDate.toISOString());
    const exactTimeSnapshot = await exactTimeQuery.get();
    
    const canceledAppointment = exactTimeSnapshot.docs.find(doc => doc.data().Status === 'Cancelado');
    
    if (canceledAppointment) {
        // Atualizar o agendamento cancelado existente
        await canceledAppointment.ref.update({
            NomeCliente: personInfo.name,
            TelefoneCliente: personInfo.phone,
            Status: 'Agendado',
            TimestampAgendamento: new Date().toISOString(),
            servicoId: servico.id,
            servicoNome: servico.nome,
            duracaoMinutos: servico.duracaoMinutos,
            // Manter a mesma DataHoraISO e DataHoraFormatada
        });
    } else {
        // Criar novo agendamento (lógica original)
        const newAppointment = {
            NomeCliente: personInfo.name,
            TelefoneCliente: personInfo.phone,
            DataHoraISO: requestedDate.toISOString(),
            DataHoraFormatada: dayjs(requestedDate).tz(CONFIG.timezone).format('DD/MM/YYYY HH:mm'),
            Status: 'Agendado',
            TimestampAgendamento: new Date().toISOString(),
            servicoId: servico.id,
            servicoNome: servico.nome,
            duracaoMinutos: servico.duracaoMinutos,
        };
        await db.collection(CONFIG.collections.schedules).add(newAppointment);
    }
}


module.exports = app;
