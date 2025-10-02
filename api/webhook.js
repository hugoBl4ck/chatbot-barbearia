// =================================================================
// WEBHOOK MULTI-TENANT COM IA PERPLEXITY - VERSÃO 4.3 (CORREÇÕES FINAIS)
// =================================================================
const express = require('express');
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
require('dayjs/locale/pt-br');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('pt-br');

const app = express();
app.use(express.json());

const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    perplexityApiKey: process.env.PERPLEXITY_API_KEY,
    timezone: 'America/Sao_Paulo',
    collections: { 
        barbearias: 'barbearias', 
        schedules: 'agendamentos', 
        config: 'horarios', 
        services: 'servicos' 
    }
};

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
}
const db = admin.firestore();

async function getIntentWithPerplexity(text, servicesList) {
    if (!CONFIG.perplexityApiKey) {
        console.error("❌ Chave da API do Perplexity não configurada.");
        return { success: false, message: "O serviço de IA não está configurado." };
    }
    
    try {
        const serviceNames = servicesList.map(s => `"${s.nome}"`).join(', ');
        const currentLocalTime = dayjs().tz(CONFIG.timezone).format('dddd, DD/MM/YYYY HH:mm');
        
        const systemPrompt = `Você é um assistente de agendamento para uma barbearia no Brasil (fuso horário: America/Sao_Paulo). 
        A data/hora atual de referência é ${currentLocalTime}. 
        Serviços disponíveis: [${serviceNames}]. 
        
        Sua tarefa é analisar a mensagem do usuário e retornar APENAS um objeto JSON válido com a estrutura: 
        {"intent": "agendarHorario" | "cancelarHorario" | "informacao", "dataHoraISO": "YYYY-MM-DDTHH:mm:ss-03:00" | null, "servicoNome": "Nome Exato do Serviço" | null}. 
        
        IMPORTANTE: 
        - Para agendamentos, SEMPRE inclua dataHoraISO no formato ISO com timezone brasileiro (-03:00)
        - Se o usuário não especificar um serviço específico, use null em servicoNome
        - Se algo não for claro, retorne null nos campos correspondentes
        - Seja preciso com a data e hora no fuso brasileiro
        - Caso o usuário use apenas o termo "corte" (sem especificar barba ou cabelo), interprete como **"Corte de Cabelo"**.
        - Se o usuário mencionar "barba", "corte de barba", "fazer a barba", então associe com **"Corte de Barba"**.
        - Se mencionar "sobrancelha", "combo", "cabelo e barba = combo" ou outros termos, associe ao serviço correspondente mais próximo disponível na lista.`;
        
        const response = await fetch("https://api.perplexity.ai/chat/completions", {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${CONFIG.perplexityApiKey}` 
            },
            body: JSON.stringify({
                model: 'sonar',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                max_tokens: 200,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            throw new Error(`API Perplexity falhou com status ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.choices[0].message.content;
        console.log("🔍 Resposta bruta da IA:", responseText);
        
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("A resposta da IA não continha JSON.");
        }
        
        const parsedResponse = JSON.parse(jsonMatch[0]);
        return { success: true, data: parsedResponse };
        
    } catch (error) {
        console.error("❌ Erro ao chamar a API Perplexity:", error);
        return { success: false, message: "Não consegui entender sua solicitação no momento." };
    }
}

app.post("/api/webhook", async (request, response) => {
    const { nome, telefone, data_hora_texto, barbeariaId } = request.body;
    console.log("\n📄 === NOVO REQUEST WEBHOOK ===\n", JSON.stringify(request.body, null, 2));
    
    try {
        if (!barbeariaId || !data_hora_texto) {
            return response.status(400).json({ 
                status: 'error', 
                message: 'Dados insuficientes.' 
            });
        }

        // Verificar se a barbearia existe
        const barbeariaRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId);
        const barbeariaSnap = await barbeariaRef.get();
        
        if (!barbeariaSnap.exists) {
            return response.status(200).json({ 
                status: 'error', 
                message: 'Barbearia não encontrada.' 
            });
        }

        // Buscar serviços ativos
        const servicesSnapshot = await barbeariaRef
            .collection(CONFIG.collections.services)
            .where('ativo', '==', true)
            .get();
            
        const servicesList = servicesSnapshot.docs.map(doc => ({ 
            id: doc.id, 
            ...doc.data() 
        }));
        
        if (servicesList.length === 0) {
            return response.status(200).json({ 
                status: 'error', 
                message: 'Nenhum serviço configurado.' 
            });
        }

        // Processar com IA
        const aiResponse = await getIntentWithPerplexity(data_hora_texto, servicesList);
        if (!aiResponse.success) {
            return response.status(200).json({ 
                status: 'error', 
                message: aiResponse.message 
            });
        }

        const { intent, dataHoraISO, servicoNome } = aiResponse.data;
        console.log("🤖 Intent processado:", { intent, dataHoraISO, servicoNome });
        
        const parsedDateDayjs = dataHoraISO ? dayjs(dataHoraISO).tz(CONFIG.timezone) : null;
        const personInfo = { name: nome, phone: telefone };

        let resultPayload;

        if (intent === 'agendarHorario') {
            if (!parsedDateDayjs || !parsedDateDayjs.isValid()) {
                resultPayload = { 
                    success: false, 
                    message: "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou 'hoje às 14h30'." 
                };
            } else {
                // Encontrar o serviço
                let servicoEncontrado;
                if (servicoNome) {
                    servicoEncontrado = servicesList.find(s => 
                        s.nome.toLowerCase().includes(servicoNome.toLowerCase()) ||
                        servicoNome.toLowerCase().includes(s.nome.toLowerCase())
                    );
                }
                
                // Se não encontrou pelo nome, usar o primeiro serviço ativo
                if (!servicoEncontrado) {
                    servicoEncontrado = servicesList[0];
                }

                if (!servicoEncontrado) {
                    resultPayload = { 
                        success: false, 
                        message: `Não encontrei o serviço "${servicoNome}".` 
                    };
                } else {
                    resultPayload = await handleScheduling(barbeariaId, personInfo, parsedDateDayjs, servicoEncontrado.id);
                }
            }
        } else if (intent === 'cancelarHorario') {
            resultPayload = await handleCancellation(barbeariaId, personInfo);
        } else {
            resultPayload = { 
                success: false, 
                message: 'Não entendi o que você quer fazer. Você quer agendar ou cancelar um horário?' 
            };
        }
        
        const responseData = { 
            status: resultPayload.success ? 'success' : 'error', 
            message: resultPayload.message, 
            type: resultPayload.type || null 
        };
        
        console.log(`\n📤 RESPOSTA ENVIADA:\n`, JSON.stringify(responseData, null, 2));
        return response.status(200).json(responseData);
        
    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.status(200).json({ 
            status: 'error', 
            message: 'Desculpe, ocorreu um erro interno.' 
        });
    }
});
    
async function handleScheduling(barbeariaId, personInfo, requestedDateDayjs, servicoId) {
    if (!personInfo.name || !personInfo.phone) {
        return { 
            success: false, 
            message: 'Para agendar, preciso do seu nome e telefone.' 
        };
    }
    
    // Verificar se não é no passado
    const currentTime = dayjs().tz(CONFIG.timezone);
    if (requestedDateDayjs.isBefore(currentTime)) {
        return { 
            success: false, 
            message: 'Não é possível agendar no passado.' 
        };
    }

    // Buscar dados do serviço
    const servicoRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.services)
        .doc(servicoId);
    const servicoSnap = await servicoRef.get();
    
    if (!servicoSnap.exists) {
        return { 
            success: false, 
            message: 'O serviço selecionado não foi encontrado.' 
        };
    }
    
    const servico = { id: servicoSnap.id, ...servicoSnap.data() };
    const duracao = servico.duracaoMinutos || 30;

    console.log(`🔧 Validando agendamento: ${requestedDateDayjs.format('YYYY-MM-DD HH:mm')} (${duracao}min)`);

    // Verificar horário de funcionamento
    const businessHoursCheck = await checkBusinessHours(barbeariaId, requestedDateDayjs, duracao);
    if (!businessHoursCheck.isOpen) {
        return { success: false, message: businessHoursCheck.message };
    }

    // Verificar conflitos
    const hasConflict = await checkConflicts(barbeariaId, requestedDateDayjs.toDate(), duracao);
    if (hasConflict) {
        const suggestions = await getAvailableSlots(barbeariaId, requestedDateDayjs.toDate(), duracao);
        return { success: false, type: 'suggestion', message: suggestions };
    }

    // Salvar agendamento
    await saveAppointment(barbeariaId, personInfo, requestedDateDayjs.toDate(), servico);
    
    const formattedDateForUser = requestedDateDayjs.format('dddd, DD [de] MMMM [às] HH:mm');
    return { 
        success: true, 
        message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.` 
    };
}

async function checkBusinessHours(barbeariaId, dateDayjs, duracaoMinutos) {
    const dayOfWeek = dateDayjs.day();
    const docRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.config)
        .doc(String(dayOfWeek));
    const docSnap = await docRef.get();

    if (!docSnap.exists || !docSnap.data().aberto) {
        return { 
            isOpen: false, 
            message: `Desculpe, não funcionamos neste dia da semana.` 
        };
    }
    
    const dayConfig = docSnap.data();
    
    const timeToMinutes = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [hours, minutes] = timeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(minutes)) return null;
        return (hours * 60) + (minutes || 0);
    };

    const requestedStartMinutes = dateDayjs.hour() * 60 + dateDayjs.minute();
    const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;

    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);

    console.log("🕐 === VERIFICAÇÃO DE HORÁRIO DE FUNCIONAMENTO ===");
    console.log(`📅 Data/hora solicitada: ${dateDayjs.format('YYYY-MM-DD HH:mm')} (${duracaoMinutos}min)`);
    console.log(`⏰ Horário solicitado (minutos): ${requestedStartMinutes} até ${requestedEndMinutes}`);
    console.log(`🌅 Manhã: ${morningStart} até ${morningEnd} (${dayConfig.InicioManha} às ${dayConfig.FimManha})`);
    console.log(`🌆 Tarde: ${afternoonStart} até ${afternoonEnd} (${dayConfig.InicioTarde} às ${dayConfig.FimTarde})`);

    // Verificar se cabe completamente no período da manhã
    const fitsInMorning = (morningStart !== null && morningEnd !== null) &&
                          (requestedStartMinutes >= morningStart && requestedEndMinutes <= morningEnd);

    // Verificar se cabe completamente no período da tarde
    const fitsInAfternoon = (afternoonStart !== null && afternoonEnd !== null) &&
                            (requestedStartMinutes >= afternoonStart && requestedEndMinutes <= afternoonEnd);
    
    console.log(`✅ Cabe na manhã? ${fitsInMorning}`);
    console.log(`✅ Cabe na tarde? ${fitsInAfternoon}`);

    if (fitsInMorning || fitsInAfternoon) {
        console.log("🎉 APROVADO: Horário está dentro do funcionamento!");
        return { isOpen: true };
    } else {
        let horarioMsg = "Nosso horário de funcionamento é";
        const periods = [];
        
        if (dayConfig.InicioManha && dayConfig.FimManha) {
            periods.push(`das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`);
        }
        
        if (dayConfig.InicioTarde && dayConfig.FimTarde) {
            periods.push(`das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}`);
        }
        
        if (periods.length === 2) {
            horarioMsg += ` ${periods[0]} e ${periods[1]}`;
        } else if (periods.length === 1) {
            horarioMsg += ` ${periods[0]}`;
        } else {
            horarioMsg = "Não há horários de funcionamento configurados";
        }
        
        const msg = `${horarioMsg}. O serviço solicitado (${duracaoMinutos} minutos) não se encaixa nesse período.`;
        console.log(`❌ REJEITADO: ${msg}`);
        return { isOpen: false, message: msg };
    }
}

async function getAvailableSlots(barbeariaId, requestedDate, duracaoMinutos) {
    const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);
    
    // Tentar encontrar slots no mesmo dia
    let availableSlots = await findAvailableSlotsForDay(barbeariaId, requestedDateDayjs, duracaoMinutos);
    if (availableSlots.length > 0) {
        return `O horário solicitado está ocupado. 😔\nMas tenho estes horários livres hoje: ${availableSlots.slice(0, 3).join(', ')}.`;
    }
    
    // Tentar amanhã
    const tomorrow = requestedDateDayjs.add(1, 'day');
    availableSlots = await findAvailableSlotsForDay(barbeariaId, tomorrow, duracaoMinutos);
    if (availableSlots.length > 0) {
        return `Não tenho mais vagas para hoje. 😔\nPara amanhã, tenho estes horários: ${availableSlots.slice(0, 3).join(', ')}.`;
    }
    
    return "Este horário já está ocupado e não encontrei outras vagas próximas. 😔";
}

async function findAvailableSlotsForDay(barbeariaId, dayDate, duracaoMinutos) {
    const dayOfWeek = dayDate.day();
    const docRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.config).doc(String(dayOfWeek));
    const docSnap = await docRef.get();
    
    if (!docSnap.exists || !docSnap.data().aberto) return [];
    
    const dayConfig = docSnap.data();
    const timeToMinutes = (str) => { if (!str) return null; const [h, m] = str.split(':').map(Number); return (h * 60) + (m || 0); };
    const formatTime = (totalMinutes) => `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;

    const morningStart = timeToMinutes(dayConfig.InicioManha);
    const morningEnd = timeToMinutes(dayConfig.FimManha);
    const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
    const afternoonEnd = timeToMinutes(dayConfig.FimTarde);
    
    const startOfDay = dayDate.startOf('day').toDate();
    const endOfDay = dayDate.endOf('day').toDate();
    const schedulesRef = db.collection(CONFIG.collections.barbearias).doc(barbeariaId).collection(CONFIG.collections.schedules);
    const q = schedulesRef.where('Status', '==', 'Agendado').where('DataHoraISO', '>=', startOfDay.toISOString()).where('DataHoraISO', '<=', endOfDay.toISOString());
    const snapshot = await q.get();
    const busySlots = snapshot.docs.map(doc => {
        const data = doc.data();
        const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
        return { start: startTime.hour() * 60 + startTime.minute(), end: startTime.hour() * 60 + startTime.minute() + data.duracaoMinutos };
    });
    
    const availableSlots = [];
    const currentTime = dayjs().tz(CONFIG.timezone); // Pega a hora atual com fuso
    
    const addSlotsFromPeriod = (start, end) => {
        if (start === null || end === null) return;
        
        for (let time = start; time + duracaoMinutos <= end; time += 15) {
            const slotDate = dayDate.hour(Math.floor(time / 60)).minute(time % 60);
            
            // =========================================================
            // LÓGICA DE VERIFICAÇÃO CORRIGIDA
            // =========================================================
            // Se a data do slot for anterior à data/hora atual, pule.
            if (slotDate.isBefore(currentTime)) {
                continue;
            }
            
            const hasConflict = busySlots.some(busy => (time < busy.end && (time + duracaoMinutos) > busy.start));
            if (!hasConflict) {
                availableSlots.push(slotDate.format('HH:mm'));
            }
        }
    };
    
    addSlotsFromPeriod(morningStart, morningEnd);
    addSlotsFromPeriod(afternoonStart, afternoonEnd);
    
    return availableSlots;
}

async function handleCancellation(barbeariaId, personInfo) {
    if (!personInfo.phone) {
        return { 
            success: false, 
            message: "Para cancelar, preciso do seu telefone.", 
            type: null 
        };
    }
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.schedules);
    
    const snapshot = await schedulesRef
        .where('TelefoneCliente', '==', personInfo.phone)
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>', new Date().toISOString())
        .get();
    
    if (snapshot.empty) {
        return { 
            success: false, 
            message: `Não encontrei nenhum agendamento futuro no seu telefone.`, 
            type: null 
        };
    }
    
    let count = 0;
    const batch = db.batch();
    
    for (const doc of snapshot.docs) {
        batch.update(doc.ref, { Status: 'Cancelado' });
        count++;
    }
    
    await batch.commit();
    
    return { 
        success: true, 
        message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.`, 
        type: null 
    };
}

async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    
    // Buscar agendamentos em um período mais amplo para garantir
    const searchStart = new Date(requestedStart - (2 * 60 * 60 * 1000)); // 2 horas antes
    const searchEnd = new Date(requestedStart + (2 * 60 * 60 * 1000));   // 2 horas depois
    
    const schedulesRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.schedules);
    
    const snapshot = await schedulesRef
        .where('Status', '==', 'Agendado')
        .where('DataHoraISO', '>=', searchStart.toISOString())
        .where('DataHoraISO', '<=', searchEnd.toISOString())
        .get();
    
    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingDuration = existingData.duracaoMinutos || 30;
        const existingEnd = existingStart + (existingDuration * 60 * 1000);
        
        // Verificar sobreposição
        if (requestedStart < existingEnd && requestedEnd > existingStart) {
            console.log(`⚠️ Conflito detectado com agendamento existente:`, {
                existing: { start: new Date(existingStart), end: new Date(existingEnd) },
                requested: { start: new Date(requestedStart), end: new Date(requestedEnd) }
            });
            return true;
        }
    }
    
    return false;
}

async function saveAppointment(barbeariaId, personInfo, requestedDate, servico) {
    const schedulesRef = db.collection(CONFIG.collections.barbearias)
        .doc(barbeariaId)
        .collection(CONFIG.collections.schedules);
    
    const newAppointment = {
        NomeCliente: personInfo.name,
        TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(),
        Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString(),
        servicoId: servico.id,
        servicoNome: servico.nome,
        preco: servico.preco || 0,
        duracaoMinutos: servico.duracaoMinutos || 30,
    };
    
    console.log("💾 Salvando agendamento:", newAppointment);
    await schedulesRef.add(newAppointment);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook rodando na porta ${PORT}`);
});

module.exports = app;
