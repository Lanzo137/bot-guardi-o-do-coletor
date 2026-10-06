'use strict';

/*
  Conecta ao servidor, fabrica/equipa uma espada de madeira e então protege
  o CaioF7, retomando o acompanhamento quando a área estiver segura.
*/

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const config = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 7000),
  username: process.env.DEFENSOR_NAME || 'GuiThuller',
  version: process.env.MC_VERSION || '26.1.2',
  auth: process.env.MC_AUTH || 'offline',
  followDistance: Number(process.env.FOLLOW_DISTANCE || 5),
  logSearchDistance: Number(process.env.LOG_SEARCH_DISTANCE || 32),
  protectionRadius: Number(process.env.PROTECTION_RADIUS || 10),
  directThreatRadius: Number(process.env.DIRECT_THREAT_RADIUS || 4),
  defenderThreatRadius: Number(process.env.DEFENDER_THREAT_RADIUS || 4),
  attackDistance: Number(process.env.ATTACK_DISTANCE || 3),
  attackCooldownMs: Number(process.env.ATTACK_COOLDOWN_MS || 650),
  creeperRetreatDistance: Number(process.env.CREEPER_RETREAT_DISTANCE || 7),
  creeperDangerRadius: Number(process.env.CREEPER_DANGER_RADIUS || 5),
  lowHealthRetreat: Number(process.env.LOW_HEALTH_RETREAT || 8),
  resumeHealth: Number(process.env.RESUME_HEALTH || 14),
  surroundedEnemyCount: Number(process.env.SURROUNDED_ENEMY_COUNT || 3),
  deathSearchRadius: Number(process.env.DEATH_SEARCH_RADIUS || 12)
};

console.log(`🔌 Tentando conectar em ${config.host}:${config.port} com a versão ${config.version} e nome ${config.username}`);

const TARGET_NAME = 'CaioF7';
let jogadorSeguido = null;
let buscaCaioInterval = null;
let avisouSemCaio = false;
let anunciouEntradaNoMundo = false;
let avisouEncontrouCaio = false;
let fazendoEspada = false;
let espadaPronta = false;
let proximaTentativaEspada = 0;
let cicloInterval = null;
let ultimoAtaque = 0;
let ultimoAlvo = null;
let alvosSuspensos = [];
let falhasCaminhoPorAlvo = new Map();
let alvosInacessiveisAte = new Map();
let modoMovimento = null;
let alvoMovimento = null;
let ultimaPosicaoObjetivo = null;
let faseCreeper = 'aproximar';
let tempoRecuoCreeper = 0;
let botAtacando = false;
let recuandoVidaBaixa = false;
let reposicionarAntesDeAtacar = false;
let recuperandoMorte = false;
let cuidandoDaFome = false;
let localDaMorte = null;
let mortePendente = false;
let tarefaRecuperacaoMorte = false;
let indiceDesvio = 0;
let caioRecebeuDanoAte = 0;
let avisouSemMadeira = false;
let avisouFalhaCaminho = false;
let assinaturaInventarioComFalha = null;
let faseCritico = 'inativo';
let alvoCritico = null;
let alturaInicioSaltoCritico = null;
let alturaMaximaSaltoCritico = null;
let ataqueCriticoPendente = false;
let inicioSaltoCritico = 0;

const mobsHostisPadrao = [
  'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'witch',
  'husk', 'drowned', 'stray', 'pillager', 'vindicator', 'evoker',
  'phantom', 'blaze', 'ghast', 'magma_cube', 'slime', 'silverfish',
  'endermite', 'guardian', 'elder_guardian', 'ravager', 'hoglin',
  'zoglin', 'piglin_brute', 'wither_skeleton', 'warden', 'enderman'
];
const mobsHostis = new Set(
  (process.env.HOSTILE_MOBS || mobsHostisPadrao.join(','))
    .split(',')
    .map((nome) => nome.trim().toLowerCase())
    .filter(Boolean)
);
const mobsDeAtaqueADistancia = new Set([
  'skeleton', 'stray', 'pillager', 'witch', 'blaze', 'ghast',
  'guardian', 'elder_guardian'
]);
const blocosEscalaveis = new Set([
  'ladder', 'vine', 'cave_vines', 'weeping_vines',
  'twisting_vines', 'scaffolding'
]);
const PRAZO_INICIO_SALTO_CRITICO_MS = 1200;

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version,
  auth: config.auth === 'offline' ? 'offline' : config.auth
});

bot.loadPlugin(pathfinder);

function itemNoInventario(nome) {
  return bot.inventory.items().find((item) => item.name === nome);
}

function espadaNoInventario() {
  return bot.heldItem?.name === 'wooden_sword' || Boolean(itemNoInventario('wooden_sword'));
}

function contarItem(nome) {
  return bot.inventory.items()
    .filter((item) => item.name === nome)
    .reduce((total, item) => total + item.count, 0);
}

function contarTroncos(baseMadeira = null) {
  return bot.inventory.items()
    .filter((item) => eTronco(item, baseMadeira))
    .reduce((total, item) => total + item.count, 0);
}

function assinaturaInventario() {
  return bot.inventory.items()
    .map((item) => `${item.name}:${item.count}`)
    .sort()
    .join('|');
}

function obterBaseMadeira(nome) {
  return nome
    .replace(/^stripped_/, '')
    .replace(/_(log|wood|stem|hyphae)$/, '');
}

function obterBaseDePranchas(nome) {
  return nome.replace(/_planks$/, '');
}

async function fabricarConfirmado(itemNome, mesa = null) {
  const item = bot.registry.itemsByName[itemNome];
  if (!item) {
    throw new Error(`Este servidor não possui o item "${itemNome}" na versão de protocolo configurada.`);
  }

  const receitas = bot.recipesFor(item.id, null, 1, mesa);
  if (receitas.length === 0) {
    throw new Error(`Não há materiais suficientes para fabricar ${itemNome}.`);
  }

  const quantidadeAntes = contarItem(itemNome);
  let erroFabricacao = null;

  try {
    await bot.craft(receitas[0], 1, mesa);
  } catch (erro) {
    erroFabricacao = erro;
  }

  const prazo = Date.now() + 4000;
  while (contarItem(itemNome) <= quantidadeAntes && Date.now() < prazo) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (contarItem(itemNome) <= quantidadeAntes) {
    const motivo = erroFabricacao ? `: ${erroFabricacao.message}` : '.';
    throw new Error(`A fabricação de ${itemNome} não foi confirmada no inventário${motivo}`);
  }

  if (erroFabricacao) {
    console.warn(`⚠️ ${itemNome} apareceu no inventário apesar do aviso de sincronização; continuando.`);
  }
}

function encontrarReceita(itemNome, mesa = null) {
  const item = bot.registry.itemsByName[itemNome];
  if (!item) {
    throw new Error(`Mineflayer não possui dados de receita para ${itemNome}.`);
  }

  const receitas = bot.recipesFor(item.id, null, 1, mesa);
  if (receitas.length === 0) {
    throw new Error(`Faltam materiais para ${itemNome}; não vou iniciar essa fabricação.`);
  }
  return receitas[0];
}

function requisitosParaEspada(baseMadeira, mesaExistente) {
  const nomePranchas = `${baseMadeira}_planks`;
  const pranchasNecessarias = mesaExistente ? 4 : 8;
  return {
    nomePranchas,
    pranchasNecessarias,
    troncosNecessarios: 3
  };
}

async function fabricarMadeiraEmPranchas(baseMadeira, pranchasAlvo) {
  const nomePranchas = `${baseMadeira}_planks`;
  const idPranchas = bot.registry.itemsByName[nomePranchas]?.id;
  if (idPranchas === undefined) {
    throw new Error(`Não existe o item "${nomePranchas}" nesta versão.`);
  }

  while (contarItem(nomePranchas) < pranchasAlvo) {
    const tronco = bot.inventory.items().find((item) => eTronco(item, baseMadeira));
    if (!tronco) {
      throw new Error(`Não há troncos de ${baseMadeira} suficientes para as pranchas necessárias.`);
    }

    encontrarReceita(nomePranchas);
    await fabricarConfirmado(nomePranchas);

    if (contarItem(nomePranchas) < pranchasAlvo && contarTroncos(baseMadeira) === 0) {
      throw new Error(`A fabricação de ${nomePranchas} não gerou pranchas suficientes.`);
    }
  }
}

function eTronco(bloco, baseMadeira = null) {
  return /(?:^|_)(log|wood|stem|hyphae)$/.test(bloco.name) &&
    (!baseMadeira || obterBaseMadeira(bloco.name) === baseMadeira);
}

function encontrarTronco(baseMadeira = null) {
  return bot.findBlock({
    matching: (bloco) => eTronco(bloco, baseMadeira),
    maxDistance: config.logSearchDistance
  });
}

async function explorarPorMadeira() {
  const angulo = Math.random() * Math.PI * 2;
  const distancia = 8 + Math.floor(Math.random() * 5);
  const x = Math.floor(bot.entity.position.x + Math.cos(angulo) * distancia);
  const z = Math.floor(bot.entity.position.z + Math.sin(angulo) * distancia);

  try {
    await bot.pathfinder.goto(new goals.GoalNearXZ(x, z, 2));
    avisouFalhaCaminho = false;
  } catch (erro) {
    if (!avisouFalhaCaminho) {
      console.warn(`⚠️ Não consegui seguir uma rota de busca: ${erro.message || erro}`);
      avisouFalhaCaminho = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function coletarTronco(baseMadeira = null) {
  const tronco = encontrarTronco(baseMadeira);

  if (!tronco) {
    if (!avisouSemMadeira) {
      console.log('🌳 Não encontrei árvore por perto. Explorando para buscar madeira...');
      avisouSemMadeira = true;
    }
    await explorarPorMadeira();
    return false;
  }

  avisouSemMadeira = false;
  avisouFalhaCaminho = false;

  try {
    await bot.pathfinder.goto(
      new goals.GoalNear(
        tronco.position.x,
        tronco.position.y,
        tronco.position.z,
        2
      )
    );
  } catch (erro) {
    if (!avisouFalhaCaminho) {
      console.warn(`⚠️ Não consegui chegar até a árvore: ${erro.message || erro}`);
      avisouFalhaCaminho = true;
    }
    await explorarPorMadeira();
    return false;
  }

  const blocoAtual = bot.blockAt(tronco.position);
  if (!blocoAtual || !/(?:^|_)(log|wood|stem|hyphae)$/.test(blocoAtual.name)) {
    return false;
  }

  if (!bot.canDigBlock(blocoAtual)) {
    throw new Error(`Não consigo quebrar o bloco ${blocoAtual.name} nesta posição.`);
  }

  const troncosAntes = contarTroncos(baseMadeira);
  try {
    await bot.dig(blocoAtual);
  } catch (erro) {
    if (!bot.blockAt(tronco.position) || !eTronco(bot.blockAt(tronco.position), baseMadeira)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (contarTroncos(baseMadeira) > troncosAntes) return true;
      return false;
    }
    throw erro;
  }

  const prazo = Date.now() + 5000;
  while (contarTroncos(baseMadeira) <= troncosAntes && Date.now() < prazo) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return contarTroncos(baseMadeira) > troncosAntes;
}

function encontrarMesaDeTrabalho() {
  const mesaId = bot.registry.blocksByName.crafting_table?.id;
  if (mesaId === undefined) return null;

  return bot.findBlock({
    matching: mesaId,
    maxDistance: 4
  });
}

async function colocarMesaDeTrabalho() {
  const mesaItem = itemNoInventario('crafting_table');
  if (!mesaItem) {
    throw new Error('A mesa de trabalho não está no inventário para ser colocada.');
  }

  const base = bot.entity.position.floored();
  const direcoes = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1)
  ];

  for (const direcao of direcoes) {
    const destino = base.plus(direcao);
    const apoio = bot.blockAt(destino.offset(0, -1, 0));
    const espacoDestino = bot.blockAt(destino);

    if (
      apoio &&
      apoio.boundingBox !== 'empty' &&
      espacoDestino &&
      espacoDestino.boundingBox === 'empty' &&
      bot.entity.position.distanceTo(apoio.position.offset(0.5, 0.5, 0.5)) <= 4.5
    ) {
      await bot.equip(mesaItem, 'hand');
      await bot.placeBlock(apoio, new Vec3(0, 1, 0));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return bot.blockAt(destino)?.name === 'crafting_table'
        ? bot.blockAt(destino)
        : encontrarMesaDeTrabalho();
    }
  }

  throw new Error('Não encontrei um espaço plano e livre para colocar a mesa de trabalho.');
}

async function garantirEspadaDeMadeira() {
  if (fazendoEspada || espadaPronta || Date.now() < proximaTentativaEspada) return;
  if (assinaturaInventarioComFalha === assinaturaInventario()) return;

  fazendoEspada = true;
  bot.pathfinder.setGoal(null);

  try {
    const espada = itemNoInventario('wooden_sword');
    if (espadaNoInventario()) {
      if (espada && bot.heldItem?.name !== 'wooden_sword') {
        await bot.equip(espada, 'hand');
      }
      console.log('🗡️ Espada de madeira equipada!');
      espadaPronta = true;
      return;
    }

    console.log('🗡️ Não tenho espada de madeira. Procurando materiais...');

    let baseMadeira =
      bot.inventory.items().find((item) => item.name.endsWith('_planks'))
        ? obterBaseDePranchas(bot.inventory.items().find((item) => item.name.endsWith('_planks')).name)
        : null;

    if (!baseMadeira) {
      const troncoExistente = bot.inventory.items().find((item) => eTronco(item));
      const troncoProximo = encontrarTronco();
      const troncoReferencia = troncoExistente?.name || troncoProximo?.name;
      if (troncoReferencia) baseMadeira = obterBaseMadeira(troncoReferencia);
    }

    while (!baseMadeira || contarTroncos(baseMadeira) < 3) {
      if (!baseMadeira) {
        const troncoPerto = encontrarTronco();
        if (troncoPerto) baseMadeira = obterBaseMadeira(troncoPerto.name);
      }

      if (!baseMadeira) {
        await coletarTronco();
        continue;
      }

      if (contarTroncos(baseMadeira) < 3) {
        const coletou = await coletarTronco(baseMadeira);
        if (!coletou) await explorarPorMadeira();
      }
    }

    console.log(`🪵 Tenho 3 troncos de ${baseMadeira}. Vou preparar os materiais antes de fabricar a espada.`);

    const mesaNaArea = encontrarMesaDeTrabalho();
    const mesaNoInventario = itemNoInventario('crafting_table');
    const mesaDisponivel = Boolean(mesaNaArea || mesaNoInventario);
    const plano = requisitosParaEspada(baseMadeira, mesaDisponivel);

    await fabricarMadeiraEmPranchas(baseMadeira, plano.pranchasNecessarias);

    if (!mesaNaArea && !mesaNoInventario) {
      console.log('🪵 Fabricando a bancada com 4 tábuas.');
      await fabricarConfirmado('crafting_table');
    }

    let mesa = encontrarMesaDeTrabalho();
    if (!mesa) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      mesa = await colocarMesaDeTrabalho();
      if (!mesa) throw new Error('A mesa de trabalho foi colocada, mas não consegui localizá-la.');
    }

    const nomePranchas = plano.nomePranchas;
    if (contarItem('stick') < 1) {
      if (contarItem(nomePranchas) < 4) {
        throw new Error('Faltam tábuas para fazer gravetos e espada; não vou iniciar a receita.');
      }
      console.log('🪵 Fazendo gravetos com 2 tábuas.');
      await fabricarConfirmado('stick');
    }

    if (contarItem(nomePranchas) < 2 || contarItem('stick') < 1) {
      throw new Error('Faltam tábuas ou graveto; não vou iniciar a receita da espada.');
    }

    const idEspada = bot.registry.itemsByName.wooden_sword?.id;
    if (idEspada === undefined) {
      throw new Error('Mineflayer não possui dados para a espada de madeira nesta versão.');
    }

    encontrarReceita('wooden_sword', mesa);
    console.log('🗡️ Materiais conferidos. Fabricando a espada de madeira.');
    await fabricarConfirmado('wooden_sword', mesa);

    const espadaCriada = itemNoInventario('wooden_sword');
    if (!espadaCriada) {
      throw new Error('A fabricação terminou, mas a espada não apareceu no inventário.');
    }

    await bot.equip(espadaCriada, 'hand');
    console.log('🗡️ Espada de madeira criada e equipada!');
    console.log('🛡️ Voltando para proteger CaioF7.');
    espadaPronta = true;
    assinaturaInventarioComFalha = null;
  } catch (erro) {
    proximaTentativaEspada = Date.now() + 5000;
    assinaturaInventarioComFalha = assinaturaInventario();
    console.error('❌ Não consegui preparar a espada:', erro.message || erro);
  } finally {
    fazendoEspada = false;
  }
}

function entidadeAtiva(entidade) {
  return entidade && bot.entities[entidade.id] === entidade && entidade.position;
}

function creeperEstaAcendendo(entidade) {
  const metadados = bot.registry.entitiesByName.creeper?.metadataKeys || [];
  const indiceIgnicao = metadados.indexOf('is_ignited');
  const indiceInchaco = metadados.indexOf('swell_dir');
  if (indiceIgnicao < 0 || !entidade.metadata) return false;

  const ignicao = entidade.metadata[indiceIgnicao];
  const inchaco = indiceInchaco >= 0 ? entidade.metadata[indiceInchaco] : 0;
  return ignicao === true || ignicao === 1 || inchaco === 1;
}

function prioridadeAmeaca(entidade, caio) {
  const distanciaCaio = entidade.position.distanceTo(caio.position);
  const distanciaDefensor = entidade.position.distanceTo(bot.entity.position);
  const creeper = entidade.name === 'creeper';
  const vidaCaio = caio.health ??
    caio.attributes?.health?.value ??
    caio.metadata?.[bot.registry.entitiesByName.player?.metadataKeys?.indexOf('health')];

  if (creeper && (creeperEstaAcendendo(entidade) || distanciaCaio <= config.creeperDangerRadius)) {
    return 0;
  }
  if (Number.isFinite(vidaCaio) && vidaCaio <= 8 && distanciaCaio <= config.protectionRadius) {
    return 1;
  }
  if (Date.now() < caioRecebeuDanoAte && distanciaCaio <= config.protectionRadius) {
    return 1;
  }
  if (distanciaCaio <= config.directThreatRadius) return 1;
  if (mobsDeAtaqueADistancia.has(entidade.name) &&
      distanciaCaio <= config.protectionRadius) return 2;
  if (distanciaDefensor <= config.defenderThreatRadius) return 2;
  if (distanciaCaio <= config.protectionRadius) return 3;
  return Infinity;
}

function ameacasNaArea(caio) {
  return Object.values(bot.entities)
    .filter((entidade) =>
      entidade &&
      entidade !== bot.entity &&
      entidade.position &&
      mobsHostis.has(entidade.name) &&
      prioridadeAmeaca(entidade, caio) !== Infinity
    )
    .map((entidade) => ({
      entidade,
      prioridade: prioridadeAmeaca(entidade, caio),
      distanciaCaio: entidade.position.distanceTo(caio.position),
      distanciaDefensor: entidade.position.distanceTo(bot.entity.position),
      vida: vidaDaEntidade(entidade)
    }))
    .sort((a, b) =>
      a.prioridade - b.prioridade ||
      a.distanciaCaio - b.distanciaCaio ||
      (a.vida ?? Infinity) - (b.vida ?? Infinity) ||
      a.distanciaDefensor - b.distanciaDefensor
    );
}

function escolherAmeaca(caio) {
  const ameacas = ameacasNaArea(caio);
  const agora = Date.now();
  for (const [id, expiraEm] of alvosInacessiveisAte) {
    if (expiraEm <= agora) alvosInacessiveisAte.delete(id);
  }
  const disponiveis = ameacas.filter((item) =>
    !alvosInacessiveisAte.has(item.entidade.id)
  );
  const atualEstaAtivo =
    entidadeAtiva(ultimoAlvo) &&
    mobsHostis.has(ultimoAlvo.name) &&
    ultimoAlvo.position.distanceTo(caio.position) <= config.protectionRadius + 8;
  const atualNaLista = disponiveis.find((item) => item.entidade === ultimoAlvo);

  if (atualEstaAtivo) {
    const prioridadeAtual = atualNaLista?.prioridade ??
      prioridadeAmeaca(ultimoAlvo, caio);
    const urgenciaMaior = disponiveis.find((item) =>
      item.entidade !== ultimoAlvo &&
      (Number.isFinite(prioridadeAtual)
        ? item.prioridade < prioridadeAtual
        : item.prioridade <= 1)
    );
    if (urgenciaMaior) {
      if (!alvosSuspensos.includes(ultimoAlvo)) {
        alvosSuspensos.push(ultimoAlvo);
      }
      return urgenciaMaior.entidade;
    }
    if (prioridadeAtual > 1) {
      while (alvosSuspensos.length > 0) {
        const suspenso = alvosSuspensos.pop();
        if (
          entidadeAtiva(suspenso) &&
          mobsHostis.has(suspenso.name) &&
          suspenso.position.distanceTo(caio.position) <= config.protectionRadius + 8 &&
          !alvosInacessiveisAte.has(suspenso.id)
        ) {
          alvosSuspensos.push(ultimoAlvo);
          return suspenso;
        }
      }
    }
    return ultimoAlvo;
  }

  while (alvosSuspensos.length > 0) {
    const suspenso = alvosSuspensos.pop();
    if (
      entidadeAtiva(suspenso) &&
      mobsHostis.has(suspenso.name) &&
      suspenso.position.distanceTo(caio.position) <= config.protectionRadius + 8 &&
      !alvosInacessiveisAte.has(suspenso.id)
    ) {
      const prioridadeSuspenso = prioridadeAmeaca(suspenso, caio);
      const outraAmeacaUrgente = disponiveis.find((item) =>
        item.prioridade < prioridadeSuspenso
      );
      if (outraAmeacaUrgente) {
        alvosSuspensos.push(suspenso);
        return outraAmeacaUrgente.entidade;
      }
      return suspenso;
    }
  }

  return disponiveis[0]?.entidade || null;
}

function definirMovimento(modo, entidade, objetivo, distanciaAtualizacao = 1.5) {
  const novaPosicao = Number.isFinite(objetivo.x) && Number.isFinite(objetivo.z)
    ? new Vec3(objetivo.x, Number.isFinite(objetivo.y) ? objetivo.y : bot.entity.position.y, objetivo.z)
    : null;
  const precisaAtualizarPosicao = novaPosicao && ultimaPosicaoObjetivo
    ? novaPosicao.distanceTo(ultimaPosicaoObjetivo) >= distanciaAtualizacao
    : Boolean(novaPosicao) !== Boolean(ultimaPosicaoObjetivo);

  if (
    modoMovimento === modo &&
    alvoMovimento === entidade &&
    !precisaAtualizarPosicao
  ) return;

  modoMovimento = modo;
  alvoMovimento = entidade;
  ultimaPosicaoObjetivo = novaPosicao;
  bot.pathfinder.setGoal(objetivo, true);
}

function voltarParaEscolta(caio) {
  faseCreeper = 'aproximar';
  tempoRecuoCreeper = 0;
  ultimoAlvo = null;
  jogadorSeguido = caio;
  definirMovimento(
    'escolta',
    caio,
    new goals.GoalFollow(caio, config.followDistance)
  );
  if (!avisouEncontrouCaio) {
    console.log('🎯 CaioF7 localizado! O defensor está em posição de proteção.');
    avisouEncontrouCaio = true;
  }
}

function pontoDeRecuo(entidade, caio) {
  let dx = bot.entity.position.x - entidade.position.x;
  let dz = bot.entity.position.z - entidade.position.z;
  let comprimento = Math.hypot(dx, dz);

  if (comprimento < 0.01) {
    dx = bot.entity.position.x - caio.position.x;
    dz = bot.entity.position.z - caio.position.z;
    comprimento = Math.hypot(dx, dz);
  }
  if (comprimento < 0.01) {
    dx = 1;
    dz = 0;
    comprimento = 1;
  }

  const distancia = config.creeperRetreatDistance;
  const direcao = { x: dx / comprimento, z: dz / comprimento };
  const candidatos = [
    direcao,
    { x: -direcao.z, z: direcao.x },
    { x: direcao.z, z: -direcao.x }
  ];
  const escolhido = candidatos
    .map((vetor) => ({
      x: bot.entity.position.x + vetor.x * distancia,
      z: bot.entity.position.z + vetor.z * distancia
    }))
    .sort((a, b) => {
      const distanciaCaioA = Math.hypot(a.x - caio.position.x, a.z - caio.position.z);
      const distanciaCaioB = Math.hypot(b.x - caio.position.x, b.z - caio.position.z);
      return distanciaCaioB - distanciaCaioA;
    })[0];

  return new goals.GoalNearXZ(Math.floor(escolhido.x), Math.floor(escolhido.z), 2);
}

function encontrarPosicaoSegura(pertoDe, afastarDe, distancia) {
  const dx = pertoDe.x - afastarDe.x;
  const dz = pertoDe.z - afastarDe.z;
  const comprimento = Math.hypot(dx, dz) || 1;
  const paraFora = { x: dx / comprimento, z: dz / comprimento };
  const candidatos = [
    paraFora,
    { x: -paraFora.z, z: paraFora.x },
    { x: paraFora.z, z: -paraFora.x },
    { x: -paraFora.x, z: -paraFora.z }
  ];
  const yBase = Math.floor(bot.entity.position.y);
  const seguros = [];

  for (const direcao of candidatos) {
    const x = Math.floor(pertoDe.x + direcao.x * distancia);
    const z = Math.floor(pertoDe.z + direcao.z * distancia);

    for (let y = yBase + 1; y >= yBase - 2; y--) {
      const apoio = bot.blockAt(new Vec3(x, y - 1, z));
      const blocoPes = bot.blockAt(new Vec3(x, y, z));
      const blocoCabeca = bot.blockAt(new Vec3(x, y + 1, z));
      if (
        apoio &&
        apoio.boundingBox !== 'empty' &&
        blocoPes &&
        blocoPes.boundingBox === 'empty' &&
        blocoCabeca &&
        blocoCabeca.boundingBox === 'empty'
      ) {
        const candidato = new Vec3(x, y, z);
        const distCaio = bot.players[TARGET_NAME]?.entity
          ? candidato.distanceTo(bot.players[TARGET_NAME].entity.position)
          : 0;
        seguros.push({ candidato, distCaio });
        break;
      }
    }
  }

  seguros.sort((a, b) => b.distCaio - a.distCaio);
  return seguros[0]?.candidato || null;
}

function pontoDeRetirada(alvo, caio) {
  const inimigoMaisProximo = alvo || bot.entity;
  const seguro = encontrarPosicaoSegura(
    bot.entity.position,
    inimigoMaisProximo.position,
    config.creeperRetreatDistance
  );
  if (seguro) return new goals.GoalNearXZ(seguro.x, seguro.z, 1);

  return pontoDeRecuo(inimigoMaisProximo, caio);
}

function numeroInimigosPertoDoDefensor(raio) {
  return Object.values(bot.entities).filter((entidade) =>
    entidade &&
    entidade !== bot.entity &&
    entidade.position &&
    mobsHostis.has(entidade.name) &&
    entidade.position.distanceTo(bot.entity.position) <= raio
  ).length;
}

function vidaDaEntidade(entidade) {
  if (Number.isFinite(entidade.health)) return entidade.health;
  const valorAtributo = entidade.attributes?.health?.value;
  if (Number.isFinite(valorAtributo)) return valorAtributo;

  const indice = bot.registry.entitiesByName[entidade.name]?.metadataKeys?.indexOf('health') ?? -1;
  if (indice >= 0 && Number.isFinite(entidade.metadata?.[indice])) {
    return entidade.metadata[indice];
  }
  return null;
}

function pontoDeAtaqueSeguro(alvo, caio) {
  const dx = alvo.position.x - caio.position.x;
  const dz = alvo.position.z - caio.position.z;
  const comprimento = Math.hypot(dx, dz) || 1;
  const paraFora = { x: dx / comprimento, z: dz / comprimento };
  const direcoesOriginais = [
    paraFora,
    { x: -paraFora.z, z: paraFora.x },
    { x: paraFora.z, z: -paraFora.x },
    { x: -paraFora.x, z: -paraFora.z }
  ];
  const direcoes = direcoesOriginais.map((_, indice) =>
    direcoesOriginais[(indice + indiceDesvio) % direcoesOriginais.length]
  );
  const candidatos = [];
  const raio = Math.max(1.4, config.attackDistance - 0.7);
  const y = Math.floor(alvo.position.y);

  for (const direcao of direcoes) {
    const x = Math.floor(alvo.position.x + direcao.x * raio);
    const z = Math.floor(alvo.position.z + direcao.z * raio);
    const apoio = bot.blockAt(new Vec3(x, y - 1, z));
    const blocoPes = bot.blockAt(new Vec3(x, y, z));
    const blocoCabeca = bot.blockAt(new Vec3(x, y + 1, z));
    if (
      !apoio ||
      apoio.boundingBox === 'empty' ||
      !blocoPes ||
      blocoPes.boundingBox !== 'empty' ||
      !blocoCabeca ||
      blocoCabeca.boundingBox !== 'empty'
    ) continue;

    const posicao = new Vec3(x, y, z);
    const distanciaCaio = posicao.distanceTo(caio.position);
    if (distanciaCaio < 2.5) continue;
    candidatos.push({
      posicao,
      distanciaCaio,
      distanciaDefensor: posicao.distanceTo(bot.entity.position),
      prioridadeDirecao: direcoesOriginais.indexOf(direcao)
    });
  }

  candidatos.sort((a, b) =>
    b.distanciaCaio - a.distanciaCaio ||
    a.prioridadeDirecao - b.prioridadeDirecao ||
    a.distanciaDefensor - b.distanciaDefensor
  );
  return candidatos[0]?.posicao || null;
}

function controlarRecuo(caio, alvo) {
  recuandoVidaBaixa = true;
  ultimoAlvo = null;
  jogadorSeguido = null;
  faseCreeper = 'aproximar';

  const pos = pontoDeRetirada(alvo, caio);
  definirMovimento(
    'recuar-vida',
    alvo,
    pos,
    2
  );

  if (bot.food < 18 && !cuidandoDaFome) {
    void alimentarSePossivel();
  }
}

async function alimentarSePossivel() {
  if (cuidandoDaFome || bot.food >= 18) return;

  const comidas = bot.inventory.items()
    .map((item) => ({
      item,
      dados: bot.registry.foods?.[item.type]
    }))
    .filter(({ item, dados }) =>
      dados &&
      !/rotten|poisonous|pufferfish|raw_/.test(item.name) &&
      item.name !== 'spider_eye'
    )
    .sort((a, b) => (b.dados.effectiveQuality || 0) - (a.dados.effectiveQuality || 0));
  const comida = comidas[0]?.item;
  if (!comida) return;

  cuidandoDaFome = true;
  try {
    await bot.equip(comida, 'hand');
    await bot.consume();
  } catch (erro) {
    console.warn(`⚠️ Não consegui comer ${comida.name}: ${erro.message || erro}`);
  } finally {
    cuidandoDaFome = false;
    const espada = itemNoInventario('wooden_sword');
    if (espada) await bot.equip(espada, 'hand').catch((erro) => {
      console.warn(`⚠️ Não consegui reequipar a espada: ${erro.message || erro}`);
    });
  }
}

function cooldownAtaqueMs() {
  const atributos = bot.entity.attributes || {};
  const atributo =
    atributos['minecraft:attack_speed'] ||
    atributos['generic.attack_speed'] ||
    atributos.attackSpeed;
  const velocidade = typeof atributo === 'number' ? atributo : atributo?.value;
  const cooldownDaArma = Number.isFinite(velocidade) && velocidade > 0
    ? 1000 / velocidade
    : config.attackCooldownMs;
  return Math.max(config.attackCooldownMs, 625, cooldownDaArma);
}

function condicoesCriticoSemSolo() {
  if (
    bot.entity.isInWater === true ||
    bot.entity.isInLava === true ||
    bot.vehicle ||
    bot.entity.vehicle ||
    bot.getControlState('sprint')
  ) return false;

  const cegueiraId = bot.registry.effectsByName?.blindness?.id;
  if (cegueiraId !== undefined && bot.entity.effects?.[cegueiraId]) return false;

  const posicao = bot.entity.position.floored();
  return ![
    bot.blockAt(posicao),
    bot.blockAt(posicao.offset(0, 1, 0))
  ].some((bloco) => bloco && blocosEscalaveis.has(bloco.name));
}

function podeTentarCritico() {
  return bot.entity.onGround === true && condicoesCriticoSemSolo();
}

function estaCaindoNoSaltoCritico() {
  const velocidadeY = bot.entity.velocity?.y;
  return (
    (faseCritico === 'descendo' || faseCritico === 'atacando') &&
    alvoCritico &&
    bot.entity.onGround === false &&
    Number.isFinite(velocidadeY) &&
    velocidadeY < -0.03 &&
    Number.isFinite(alturaMaximaSaltoCritico) &&
    bot.entity.position.y < alturaMaximaSaltoCritico &&
    condicoesCriticoSemSolo()
  );
}

async function tentarAtaque(entidade, critico = false) {
  if (botAtacando || Date.now() - ultimoAtaque < cooldownAtaqueMs()) return null;
  if (!entidadeAtiva(entidade)) return null;
  if (bot.entity.position.distanceTo(entidade.position) > config.attackDistance) return null;

  botAtacando = true;
  try {
    await bot.lookAt(
      entidade.position.offset(0, Math.max(0.5, (entidade.height || 1) * 0.65), 0),
      false
    );
    if (
      !entidadeAtiva(entidade) ||
      bot.entity.position.distanceTo(entidade.position) > config.attackDistance ||
      (critico && !estaCaindoNoSaltoCritico())
    ) return false;

    const entidadeMirada = bot.entityAtCursor(config.attackDistance + 0.25);
    const blocoMirado = bot.blockAtCursor(config.attackDistance + 0.25);
    if (
      !entidadeMirada ||
      entidadeMirada.id !== entidade.id ||
      (blocoMirado && blocoMirado.position.distanceTo(bot.entity.position) <
        entidade.position.distanceTo(bot.entity.position))
    ) return false;
    bot.attack(entidade);
    ultimoAtaque = Date.now();
    return true;
  } catch (erro) {
    console.warn(`⚠️ Não consegui alinhar o ataque em ${entidade.name}: ${erro.message || erro}`);
    return false;
  } finally {
    botAtacando = false;
  }
}

function cancelarCritico() {
  bot.setControlState('jump', false);
  faseCritico = 'inativo';
  alvoCritico = null;
  alturaInicioSaltoCritico = null;
  alturaMaximaSaltoCritico = null;
  ataqueCriticoPendente = false;
  inicioSaltoCritico = 0;
}

function atualizarAtaqueCritico(alvo, distancia) {
  // O crítico depende do estado observado pelo physicsTick, não de um atraso fixo.
  const velocidadeY = bot.entity.velocity?.y;
  const noAr = bot.entity.onGround === false;

  if (alvoCritico && alvoCritico !== alvo) cancelarCritico();
  if (faseCritico !== 'inativo') bot.setControlState('sprint', false);
  if (!entidadeAtiva(alvo) || distancia > config.attackDistance ||
      bot.health <= config.lowHealthRetreat ||
      numeroInimigosPertoDoDefensor(4) >= config.surroundedEnemyCount ||
      (faseCritico !== 'inativo' && !condicoesCriticoSemSolo())) {
    cancelarCritico();
    return;
  }

  if (faseCritico === 'inativo') {
    if (bot.entity.onGround && distancia <= config.attackDistance) {
      bot.setControlState('sprint', false);
    }
    if (
      podeTentarCritico() &&
      Date.now() - ultimoAtaque >= cooldownAtaqueMs()
    ) {
      alvoCritico = alvo;
      faseCritico = 'saltando';
      alturaInicioSaltoCritico = bot.entity.position.y;
      alturaMaximaSaltoCritico = bot.entity.position.y;
      inicioSaltoCritico = Date.now();
      bot.setControlState('sprint', false);
      bot.setControlState('jump', true);
    }
    return;
  }

  if (faseCritico === 'saltando' && noAr) {
    bot.setControlState('jump', false);
    if (Number.isFinite(velocidadeY) && velocidadeY > 0.03) {
      faseCritico = 'subindo';
      alturaMaximaSaltoCritico = bot.entity.position.y;
    } else {
      cancelarCritico();
      return;
    }
  } else if (
    faseCritico === 'saltando' &&
    bot.entity.onGround &&
    Date.now() - inicioSaltoCritico > PRAZO_INICIO_SALTO_CRITICO_MS
  ) {
    cancelarCritico();
    return;
  }
  if (faseCritico === 'subindo' && noAr) {
    alturaMaximaSaltoCritico = Math.max(
      alturaMaximaSaltoCritico,
      bot.entity.position.y
    );
    if (
      bot.entity.position.y >= alturaInicioSaltoCritico + 0.08 &&
      Number.isFinite(velocidadeY) &&
      velocidadeY < -0.03
    ) {
      faseCritico = 'descendo';
    }
  }
  if (
    faseCritico === 'descendo' &&
    estaCaindoNoSaltoCritico() &&
    !ataqueCriticoPendente &&
    Date.now() - ultimoAtaque >= cooldownAtaqueMs()
  ) {
    ataqueCriticoPendente = true;
    faseCritico = 'atacando';
    void tentarAtaque(alvo, true).then((resultado) => {
      if (alvoCritico !== alvo || faseCritico !== 'atacando') return;
      ataqueCriticoPendente = false;
      if (resultado === null) {
        faseCritico = 'descendo';
        return;
      }
      faseCritico = 'reposicionar';
      reposicionarAntesDeAtacar = true;
      if (resultado === true) indiceDesvio = (indiceDesvio + 1) % 4;
    });
    return;
  }
  if (faseCritico === 'reposicionar') cancelarCritico();
  else if (faseCritico !== 'saltando' && bot.entity.onGround) cancelarCritico();
}

function atualizarCombate(caio, alvo) {
  if (alvo !== ultimoAlvo) {
    cancelarCritico();
    alvosSuspensos = alvosSuspensos.filter((suspenso) => suspenso !== alvo);
    ultimoAlvo = alvo;
    reposicionarAntesDeAtacar = false;
    faseCreeper = 'aproximar';
    tempoRecuoCreeper = 0;
    jogadorSeguido = null;
    console.log(`🚨 Ameaça prioritária perto de CaioF7: ${alvo.name}.`);
  }

  if (alvo.name !== 'creeper') {
    faseCreeper = 'aproximar';
    const lotado = numeroInimigosPertoDoDefensor(4) >= config.surroundedEnemyCount;
    if (bot.health <= config.lowHealthRetreat || lotado) {
      if (!recuandoVidaBaixa) {
        console.warn(lotado
          ? '⚠️ Estou cercado; reposicionando para sair do grupo.'
          : '⚠️ Vida baixa; recuando antes de continuar o combate.');
      }
      controlarRecuo(caio, alvo);
      return;
    }

    if (recuandoVidaBaixa) {
      if (bot.health < config.resumeHealth || lotado) return;
      recuandoVidaBaixa = false;
      modoMovimento = null;
      alvoMovimento = null;
      console.log('❤️ Condições melhores; retomando a defesa.');
    }

    if (faseCritico === 'reposicionar') cancelarCritico();
    const distanciaAlvo = bot.entity.position.distanceTo(alvo.position);
    const posicaoAtaque = pontoDeAtaqueSeguro(alvo, caio);
    const distanciaAtePosicao = posicaoAtaque
      ? bot.entity.position.distanceTo(posicaoAtaque)
      : Infinity;
    if (reposicionarAntesDeAtacar) {
      if (!posicaoAtaque) {
        definirMovimento(
          'recuar-apos-ataque',
          alvo,
          pontoDeRetirada(alvo, caio),
          2
        );
        return;
      }
      if (distanciaAtePosicao > 1.4) {
        definirMovimento(
          'reposicionar-apos-ataque',
          alvo,
          new goals.GoalNear(
            posicaoAtaque.x,
            posicaoAtaque.y,
            posicaoAtaque.z,
            1
          ),
          1.25
        );
        return;
      }
      reposicionarAntesDeAtacar = false;
      modoMovimento = null;
      alvoMovimento = null;
    }

    atualizarAtaqueCritico(alvo, distanciaAlvo);
    if (faseCritico !== 'inativo' && faseCritico !== 'reposicionar') return;

    if (
      distanciaAlvo > config.attackDistance
    ) {
      if (posicaoAtaque) {
        definirMovimento(
          'posicionar-combate',
          alvo,
          new goals.GoalNear(
            posicaoAtaque.x,
            posicaoAtaque.y,
            posicaoAtaque.z,
            1
          ),
          1.25
        );
      } else {
        definirMovimento(
          'combate',
          alvo,
          new goals.GoalFollow(alvo, Math.max(1, config.attackDistance - 0.35))
        );
      }
    } else {
      definirMovimento(
        'combate',
        alvo,
        new goals.GoalFollow(alvo, Math.max(1, config.attackDistance - 0.35))
      );
    }
    if (distanciaAlvo <= config.attackDistance && bot.entity.onGround) {
      void tentarAtaque(alvo).then((ataqueEnviado) => {
        if (ataqueEnviado === null || !entidadeAtiva(alvo)) return;
        indiceDesvio = (indiceDesvio + 1) % 4;
        reposicionarAntesDeAtacar = true;
        modoMovimento = null;
        alvoMovimento = null;
      });
    }
    return;
  }

  cancelarCritico();
  const distanciaDefensor = bot.entity.position.distanceTo(alvo.position);
  const estaAcendendo = creeperEstaAcendendo(alvo);

  if (estaAcendendo) {
    faseCreeper = 'recuar';
    tempoRecuoCreeper = Date.now();
  }

  if (faseCreeper === 'recuar') {
    if (estaAcendendo || distanciaDefensor < config.creeperRetreatDistance - 1) {
      definirMovimento('recuo-creeper', alvo, pontoDeRetirada(alvo, caio));
      return;
    }

    if (Date.now() - tempoRecuoCreeper < 1200) return;
    faseCreeper = 'aproximar';
    modoMovimento = null;
    alvoMovimento = null;
  }

  const lotado = numeroInimigosPertoDoDefensor(4) >= config.surroundedEnemyCount;
  if (bot.health <= config.lowHealthRetreat || lotado) {
    controlarRecuo(caio, alvo);
    return;
  }

  if (recuandoVidaBaixa) {
    if (bot.health < config.resumeHealth || lotado) return;
    recuandoVidaBaixa = false;
    modoMovimento = null;
    alvoMovimento = null;
  }

  const posicaoAtaqueCreeper = pontoDeAtaqueSeguro(alvo, caio);
  if (posicaoAtaqueCreeper) {
    definirMovimento(
      'aproximar-creeper-seguro',
      alvo,
      new goals.GoalNear(
        posicaoAtaqueCreeper.x,
        posicaoAtaqueCreeper.y,
        posicaoAtaqueCreeper.z,
        1
      ),
      1.25
    );
  } else {
    definirMovimento(
      'aproximar-creeper',
      alvo,
      new goals.GoalFollow(alvo, Math.max(1, config.attackDistance - 0.2))
    );
  }

  if (distanciaDefensor <= config.attackDistance) {
    void (async () => {
      const ataquesAntes = ultimoAtaque;
      const ataqueEnviado = await tentarAtaque(alvo);
      if (ataqueEnviado === false && entidadeAtiva(alvo)) {
        indiceDesvio = (indiceDesvio + 1) % 4;
        modoMovimento = null;
        alvoMovimento = null;
        return;
      }
      if (ultimoAtaque !== ataquesAntes && entidadeAtiva(alvo)) {
        faseCreeper = 'recuar';
        tempoRecuoCreeper = Date.now();
        modoMovimento = null;
        alvoMovimento = null;
        definirMovimento('recuo-creeper', alvo, pontoDeRetirada(alvo, caio));
      }
    })();
  }
}

function itensCaidosPertoDo(local) {
  return Object.values(bot.entities)
    .filter((entidade) =>
      entidade &&
      entidade.name === 'item' &&
      entidade.position &&
      entidade.position.distanceTo(local) <= config.deathSearchRadius
    )
    .sort((a, b) =>
      a.position.distanceTo(bot.entity.position) -
      b.position.distanceTo(bot.entity.position)
    );
}

async function tentarAlcancarItemCaido(item) {
  if (!entidadeAtiva(item)) return false;
  const posicao = item.position.floored();
  try {
    await bot.pathfinder.goto(
      new goals.GoalNear(posicao.x, posicao.y, posicao.z, 1)
    );
  } catch (erro) {
    console.warn(`⚠️ Não consegui alcançar um item dropado: ${erro.message || erro}`);
    return false;
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));
  return !entidadeAtiva(item);
}

async function recuperarAposMorte() {
  if (tarefaRecuperacaoMorte || !localDaMorte) return;
  tarefaRecuperacaoMorte = true;
  recuperandoMorte = true;
  espadaPronta = espadaNoInventario();
  bot.pathfinder.setGoal(null);
  modoMovimento = null;
  alvoMovimento = null;

  const local = localDaMorte.clone();
  console.log(`🔄 Respawn. Voltando ao local da morte (${Math.floor(local.x)} ${Math.floor(local.y)} ${Math.floor(local.z)}).`);

  try {
    let chegouAoLocal = false;
    for (let tentativa = 1; tentativa <= 3 && !chegouAoLocal; tentativa++) {
      try {
        await bot.pathfinder.goto(
          new goals.GoalNearXZ(
            Math.floor(local.x),
            Math.floor(local.z),
            tentativa === 1 ? 3 : 5
          )
        );
        chegouAoLocal = true;
      } catch (erro) {
        console.warn(
          `⚠️ Tentativa ${tentativa}/3 para voltar ao local da morte falhou: ${erro.message || erro}`
        );
        if (tentativa < 3) {
          indiceDesvio = (indiceDesvio + 1) % 4;
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      }
    }
    if (!chegouAoLocal) {
      console.warn('⚠️ Não consegui alcançar a área da morte após 3 tentativas; vou procurar drops acessíveis e preparar outra espada se necessário.');
    }

    const prazo = Date.now() + 15000;
    let ciclosSemItens = 0;
    while (Date.now() < prazo && ciclosSemItens < 4) {
      const caidos = itensCaidosPertoDo(local);
      if (caidos.length === 0) {
        ciclosSemItens++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      ciclosSemItens = 0;
      console.log(`🎒 Encontrei ${caidos.length} item(ns) dropado(s); tentando recuperar.`);
      for (const item of caidos) {
        if (!entidadeAtiva(item)) continue;
        await tentarAlcancarItemCaido(item);
        if (Date.now() >= prazo) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const espada = itemNoInventario('wooden_sword');
    if (espada) {
      await bot.equip(espada, 'hand');
      espadaPronta = true;
      console.log('🛡️ Espada recuperada; equipamento pronto para voltar à proteção.');
    } else {
      espadaPronta = false;
      console.warn('⚠️ Não encontrei a espada dropada. Vou fabricar outra antes de defender CaioF7.');
    }
  } catch (erro) {
    console.error(`❌ Erro durante a recuperação da morte: ${erro.message || erro}`);
  } finally {
    localDaMorte = null;
    mortePendente = false;
    recuperandoMorte = false;
    tarefaRecuperacaoMorte = false;
    jogadorSeguido = null;
    ultimoAlvo = null;
    modoMovimento = null;
    alvoMovimento = null;
    ultimaPosicaoObjetivo = null;
    if (!espadaPronta) void garantirEspadaDeMadeira();
    console.log('🎯 Retornando à área de proteção de CaioF7.');
  }
}

function atualizarProtecao() {
  if (fazendoEspada) return;
  if (recuperandoMorte) return;
  if (cuidandoDaFome) return;
  if (espadaPronta && !espadaNoInventario()) {
    espadaPronta = false;
    ultimoAlvo = null;
    modoMovimento = null;
    console.warn('⚠️ A espada não está mais no inventário; vou pausar a proteção para fabricar outra.');
  }
  if (!espadaPronta) {
    void garantirEspadaDeMadeira();
    return;
  }

  const caio = bot.players[TARGET_NAME]?.entity;
  if (!caio) {
    if (modoMovimento) bot.pathfinder.setGoal(null);
    jogadorSeguido = null;
    ultimoAlvo = null;
    modoMovimento = null;
    alvoMovimento = null;
    if (!avisouSemCaio) {
      console.log(`🔎 Procurando ${TARGET_NAME}...`);
      avisouSemCaio = true;
    }
    return;
  }

  avisouSemCaio = false;
  const alvo = escolherAmeaca(caio);
  const inimigosProximos = numeroInimigosPertoDoDefensor(5);
  const inimigoCercando = Object.values(bot.entities)
    .filter((entidade) =>
      entidade &&
      entidade !== bot.entity &&
      entidade.position &&
      mobsHostis.has(entidade.name) &&
      entidade.position.distanceTo(bot.entity.position) <= 8
    )
    .sort((a, b) =>
      a.position.distanceTo(bot.entity.position) -
      b.position.distanceTo(bot.entity.position)
    )[0] || null;
  const precisaRecuar =
    (Number.isFinite(bot.health) && bot.health <= config.lowHealthRetreat) ||
    inimigosProximos >= config.surroundedEnemyCount;

  if (precisaRecuar && (alvo || inimigoCercando || bot.health <= 5)) {
    if (!recuandoVidaBaixa) {
      console.warn(inimigosProximos >= config.surroundedEnemyCount
        ? '⚠️ Muitos inimigos ao redor; saindo do cerco.'
        : '⚠️ Vida baixa; recuando para evitar morrer.');
    }
    controlarRecuo(caio, alvo || inimigoCercando);
    return;
  }

  if (recuandoVidaBaixa) {
    if (bot.health < config.resumeHealth) {
      if (bot.food < 18) void alimentarSePossivel();
      return;
    }
    recuandoVidaBaixa = false;
    modoMovimento = null;
    alvoMovimento = null;
    ultimaPosicaoObjetivo = null;
    console.log('❤️ Vida recuperada; voltando para a proteção.');
  }

  if (alvo) {
    atualizarCombate(caio, alvo);
    return;
  }

  if (bot.food < 12) void alimentarSePossivel();

  if (ultimoAlvo) {
    console.log('✅ Área próxima de CaioF7 segura; retomando a escolta.');
  }
  voltarParaEscolta(caio);
}

bot.on('physicsTick', () => {
  if (faseCritico === 'inativo' || faseCritico === 'reposicionar') return;
  const caio = bot.players[TARGET_NAME]?.entity;
  const alvo = alvoCritico;
  if (!caio || !entidadeAtiva(alvo) || alvo.name === 'creeper') {
    cancelarCritico();
    return;
  }
  atualizarAtaqueCritico(alvo, bot.entity.position.distanceTo(alvo.position));
});

bot.on('connect', () => {
  console.log(`✅ Conexão TCP estabelecida com ${config.host}:${config.port}.`);
});

bot.on('login', () => {
  console.log(`🛡️ Bot defensor conectado como ${config.username}.`);
});

bot.on('death', () => {
  if (bot.entity?.position) {
    localDaMorte = bot.entity.position.clone();
    mortePendente = true;
    console.error(
      `💀 DEFENSOR MORREU! Local: ${Math.floor(localDaMorte.x)} ${Math.floor(localDaMorte.y)} ${Math.floor(localDaMorte.z)}`
    );
  }
  espadaPronta = false;
  recuperandoMorte = true;
  assinaturaInventarioComFalha = null;
  alvosSuspensos = [];
  falhasCaminhoPorAlvo.clear();
  alvosInacessiveisAte.clear();
  cancelarCritico();
  ultimoAlvo = null;
  modoMovimento = null;
  alvoMovimento = null;
  ultimaPosicaoObjetivo = null;
  bot.pathfinder.setGoal(null);
  recuandoVidaBaixa = false;
});

bot.on('entityHurt', (entidade) => {
  const caio = bot.players[TARGET_NAME]?.entity;
  if (caio && entidade.id === caio.id) {
    caioRecebeuDanoAte = Date.now() + 2000;
  }
});

bot.on('entityGone', (entidade) => {
  falhasCaminhoPorAlvo.delete(entidade.id);
  alvosInacessiveisAte.delete(entidade.id);
  alvosSuspensos = alvosSuspensos.filter((suspenso) => suspenso !== entidade);
  if (entidade === ultimoAlvo) {
    console.log(`ℹ️ O alvo ${entidade.name} saiu do alcance de observação; reavaliando as ameaças.`);
    ultimoAlvo = null;
    cancelarCritico();
    modoMovimento = null;
    alvoMovimento = null;
    ultimaPosicaoObjetivo = null;
  }
});

bot.on('path_reset', (motivo) => {
  if (motivo !== 'stuck' || fazendoEspada || recuperandoMorte) return;

  const alvoComCaminho = alvoMovimento;
  indiceDesvio = (indiceDesvio + 1) % 4;
  modoMovimento = null;
  alvoMovimento = null;
  ultimaPosicaoObjetivo = null;
  bot.pathfinder.setGoal(null);
  if (alvoComCaminho && mobsHostis.has(alvoComCaminho.name)) {
    const tentativas = (falhasCaminhoPorAlvo.get(alvoComCaminho.id) || 0) + 1;
    falhasCaminhoPorAlvo.set(alvoComCaminho.id, tentativas);
    if (tentativas >= 3) {
      alvosInacessiveisAte.set(alvoComCaminho.id, Date.now() + 15000);
      alvosSuspensos = alvosSuspensos.filter((suspenso) => suspenso !== alvoComCaminho);
      if (ultimoAlvo === alvoComCaminho) ultimoAlvo = null;
      cancelarCritico();
      console.warn(`⚠️ ${alvoComCaminho.name} está inacessível após 3 tentativas; vou priorizar outra ameaça.`);
      return;
    }
  }
  console.warn('⚠️ Caminho bloqueado; vou saltar/recalcular por outro lado.');
});

bot.on('goal_reached', () => {
  if (alvoMovimento) falhasCaminhoPorAlvo.delete(alvoMovimento.id);
});

bot.on('spawn', () => {
  if (mortePendente) {
    console.log('🔄 Respawn do defensor detectado.');
  }

  espadaPronta = espadaNoInventario();
  avisouEncontrouCaio = false;
  alvosSuspensos = [];
  falhasCaminhoPorAlvo.clear();
  alvosInacessiveisAte.clear();
  cancelarCritico();
  ultimoAlvo = null;
  modoMovimento = null;
  alvoMovimento = null;
  ultimaPosicaoObjetivo = null;
  faseCreeper = 'aproximar';
  tempoRecuoCreeper = 0;
  botAtacando = false;
  recuandoVidaBaixa = false;

  if (!anunciouEntradaNoMundo) {
    console.log('🛡️ Bot defensor entrou no mundo!');
    anunciouEntradaNoMundo = true;
  }

  const movimentos = new Movements(bot);
  movimentos.canDig = false;
  movimentos.allowParkour = true;
  movimentos.allow1by1towers = false;
  movimentos.maxDropDown = 2;
  bot.pathfinder.setMovements(movimentos);
  bot.pathfinder.thinkTimeout = 30000;
  bot.pathfinder.searchRadius = -1;
  bot.pathfinder.setGoal(null);
  jogadorSeguido = null;

  if (buscaCaioInterval) {
    clearInterval(buscaCaioInterval);
  }
  if (cicloInterval) {
    clearInterval(cicloInterval);
  }

  buscaCaioInterval = setInterval(atualizarProtecao, 750);
  cicloInterval = buscaCaioInterval;

  if (mortePendente && localDaMorte) {
    void recuperarAposMorte();
  } else {
    void garantirEspadaDeMadeira();
  }
});

bot.on('error', (err) => {
  console.error('❌ Erro do bot defensor:', err.message || err);
  console.error('👉 Verifique host, porta e versão do servidor.');
});

bot.on('kicked', (reason) => {
  console.error('🚫 Defensor foi kickado do servidor:', reason);
});

bot.on('end', (reason) => {
  if (buscaCaioInterval) {
    clearInterval(buscaCaioInterval);
    buscaCaioInterval = null;
  }
  cicloInterval = null;
  console.warn('⚠️ Conexão do defensor encerrada:', reason);
  console.warn('👉 Isso geralmente acontece quando o servidor fecha a conexão, a porta está errada ou a versão não bate.');
});
