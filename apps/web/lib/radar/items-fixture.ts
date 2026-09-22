import type { TenderItemView } from './contract'

/**
 * The fifteen items of `12342663000173-1-000017/2026`, exactly as our
 * `tender_items` rows hold them.
 *
 * Not invented and not rounded: this is the tender the Itens tab was verified
 * against, row for row, against PNCP's own table —
 *
 * | ours                    | PNCP                     |
 * |-------------------------|--------------------------|
 * | 15 rows                 | 15 rows                  |
 * | sum R$ 2.988.571,02     | header R$ 2.988.571,02   |
 * | 1 · 400 × R$ 816,67     | = R$ 326.668,00          |
 *
 * so a test that renders these and asserts those strings is asserting the
 * claim the tab makes, not a fixture somebody typed. The tender's own
 * `estimated_value` is **null** in production today, which is the state the
 * backfill lane is changing and the reason the sum below is labelled as a sum
 * of items and never as the tender's value.
 */
export const TENDER_ITEMS_FIXTURE: TenderItemView[] = [
    {
      "number": 1,
      "description": "FILMAGEM COM CAMÊRA COM TECNOLOGIA DIGITAL DE ALTA DEFINIÇÃO, PADRÃO FULL HD E 4K, COM TRANSPORTE DE EQUIPE E EQUIPAMENTOS.",
      "kind": "S",
      "quantity": "400.0",
      "unit": "Hora",
      "unitEstimatedValue": "816.6700",
      "totalValue": "326668.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 2,
      "description": "SERVIÇO DE EDIÇÃO: EDIÇÃO DE VÍDEO INSTITUCIONAL E/OU PROMOCIONAL DE 1 A 5 MINUTOS COM TRILHA SONORA DE BANCA DE TRILHA LICENCIADA.",
      "kind": "S",
      "quantity": "400.0",
      "unit": "Minuto",
      "unitEstimatedValue": "516.6700",
      "totalValue": "206668.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 3,
      "description": "COBERTURA FOTOGRÁFICA PARA EVENTOS, COM DURAÇÃO DE 4 A 6 HORAS, COM TRANSPORTE DE EQUIPE E EQUIPAMENTOS.",
      "kind": "S",
      "quantity": "200.0",
      "unit": "Hora",
      "unitEstimatedValue": "683.3300",
      "totalValue": "136666.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 4,
      "description": "LOCUÇÃO OFF PARA VÍDEO /DE BANCO DE VOZES (MASCULINAS, FEMININAS, INSTITUCIONAL/ CLÁSSICA, TEATRAL/CARICATA.",
      "kind": "S",
      "quantity": "800.0",
      "unit": "Minuto",
      "unitEstimatedValue": "616.6700",
      "totalValue": "493336.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 5,
      "description": "FILMAGEM COM DRONE DE ÚLTIMA GERAÇÃO, DOTADOS DE SISTEMAS DE GEOPOSICIONAMENTO COM RESOLUÇÃO FULL HD E 4K, COM TRANSPORTE DE EQUIPE E EQUIPAMENTOS.",
      "kind": "S",
      "quantity": "300.0",
      "unit": "Hora",
      "unitEstimatedValue": "866.6700",
      "totalValue": "260001.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 6,
      "description": "SERVIÇOS DE FILMAGEM COM TRANSMISSÃO EM TEMPO REAL VIA WEB, COM MESA DE CORTE COM ATÉ 5 (CINCO) FILMADORAS PROFISSIONAIS, COM SISTEMA DE LINK SEM FIO UHF E STREAMS PARA ATÉ 3 REDES SOCIAIS COM CAPTURA DE ÁUDIO DIRETO DA MESA DE ÁUDIO DO LOCAL, COM POSSIBILIDADE DE TRANSMISSÃO SIMULTÂNEA PARA SISTEMA DE PROJEÇÃO DO LOCAL. EQUIPE TÉCNICA COMPLETA COM CINEGRAFISTAS, OPERADORES E DIRETOR DE CORTE. TRANSPORTE DE EQUIPE E EQUIPAMENTOS. SOLENIDADES E EVENTOS. POR EVENTO DE ATÉ 6 HORAS.",
      "kind": "S",
      "quantity": "100.0",
      "unit": "Hora",
      "unitEstimatedValue": "8333.3300",
      "totalValue": "833333.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 7,
      "description": "EQUIPE CRIATIVA PARA PRODUÇÃO DE VÍDEO INSTITUCIONAL E/OU PROMOCIONAL, COMPOSTA DE DIRETOR DE CENA, DIRETOR DE",
      "kind": "S",
      "quantity": "150.0",
      "unit": "Hora",
      "unitEstimatedValue": "683.3300",
      "totalValue": "102499.50",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 8,
      "description": "EDIÇÃO DE MATÉRIA JORNALÍSTICA E VÍDEO UTILIZANDO IMAGENS CAPTADAS POR ESTE CONTRATO E/OU BANCA DE IMAGENS JA EXISTENTE ILHA DE EDIÇÃO COMPATÍVEL COM O FORMATO DAS IMAGENS CAPTADAS, COM PROFISSIONAIS ESPECIALIZADOS PARA A UTILIZAÇÃO DA ILHA.",
      "kind": "S",
      "quantity": "200.0",
      "unit": "Minuto",
      "unitEstimatedValue": "666.6700",
      "totalValue": "133334.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 9,
      "description": "APRESENTADOR, ATOR OU REPÓRTER PARA ATUAR EM VÍDEO, COM TRANSPORTE DE EQUIPE E EQUIPAMENTOS.",
      "kind": "S",
      "quantity": "40.0",
      "unit": "Hora",
      "unitEstimatedValue": "833.3300",
      "totalValue": "33333.20",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 10,
      "description": "CÂMERA ADICIONAL PARA CAPTAÇÃO EM FORMATO JORNALÍSTICO (INTERNO/EXTERNO) DE EVENTOS E SOLELINIDADES COM GRAVAÇÃO DE ENTREVISTA, PADRÃO FULLHD (1920 X 1080), COM CINEGRAFISTA E KIT DE MICROFONES, COM TRANSPORTE DE EQUIPE E EQUIPAMENTOS.",
      "kind": "S",
      "quantity": "200.0",
      "unit": "Hora",
      "unitEstimatedValue": "483.3300",
      "totalValue": "96666.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 11,
      "description": "COBERTURA DE EVENTO COM 1 CÂMERA, PADRÃOHD (1920 X 1080). COM TRANSPORTE DE EQUIPE E EQUIPAMENTOS.",
      "kind": "S",
      "quantity": "200.0",
      "unit": "Hora",
      "unitEstimatedValue": "583.3300",
      "totalValue": "116666.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 12,
      "description": "SERVIÇO DE PRODUÇÃO AUDIOVISUAL AVANÇADA: FILMAGEM EM ESTÚDIO PROFISSIONAL COM ISOLAMENTO ACÚSTICO DE ALTA EFICIÊNCIA, FUNDO INFINITO CHROMA KEY PARA EFEITOS ESPECIAIS, ESTRUTURA SUSPENSA PARA ILUMINAÇÃO PERSONALIZADA, AR- CONDICIONADO CLIMATIZADO, ARMÁRIOS SEGUROS PARA EQUIPAMENTOS, TELEPROMPTER PARA APRESENTAÇÕES PRECISAS, MICROFONES WIRELESS SONY UWP-D21 LAPELA SEM FIO E COM VARA PARA GRAVAÇÕES VERSÁTEIS, FONES DE OUVIDO PARA MONITORAMENTO EM TEMPO REAL, MODIFICADORES DE LUZ (DIFUSORES, REBATEDORES, BLOQUEADORES) PARA EFEITOS VISUAIS, PEDESTAL DE LUZ PARA ILUMINAÇÃO PRECISA, CÂMERA MIRRORLESS 12MP FULL- FRAME COM SENSOR EXMOR R BSI CMOS, CAPACIDADE DE VÍDEO UHD 4K 120P, SAÍDA RAW 16 BITS, GAMA HLG & S-LOG3 PARA QUALIDADE CINEMATOGRÁFICA, AF HÍBRIDO RÁPIDO 759 PONTOS PARA FOCO PRECISO. EQUIPE ESPECIALIZADA DE 3 PROFISSIONAIS (DIRETOR, OPERADOR DE CÂMERA E TÉCNICO DE SOM), INCLUI TRANSPORTE SEGURO E ALIMENTAÇÃO, ATÉ 8 HORAS DE GRAVAÇÃO PARA PRODUÇÕES DE ALTA QUALIDADE: ENTREVISTAS, DEPOIMENTOS, PODCAST, VÍDEO-AULAS, COMERCIAIS, DOCUMENTÁRIOS E OUTROS PROJETOS AUDIOVISUAIS.",
      "kind": "S",
      "quantity": "36.0",
      "unit": "Hora",
      "unitEstimatedValue": "4666.6700",
      "totalValue": "168000.12",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 13,
      "description": "SERVIÇO DE ELABORAÇÃO DE ARTE GRÁFICA PERSONALIZADA: CRIAÇÃO DE CONCEITO, DESIGN, DIAGRAMAÇÃO E FINALIZAÇÃO, FORMATO ESPECÍFICO, RESOLUÇÃO 300 DPI, COR CMYK, ARQUIVO FINAL EM PDF, INCLUINDO LOGOTIPO, TEXTOS, IMAGENS, ILUSTRAÇÕES, CORES E TIPOGRAFIA DEFINIDAS, UTILIZANDO ADOBE CREATIVE CLOUD E CORELDRAW, COM PRAZO DE ENTREGA DEFINIDO, QUANTIDADE ESPECÍFICA, EXPERIÊNCIA COMPROVADA EM DESIGN GRÁFICO, CONHECIMENTO EM DESIGN PARA IMPRESSÃO E DIGITAL, ENTREGA DE ARQUIVOS ORGANIZADOS, ACOMPANHAMENTO E REVISÕES ATÉ APROVAÇÃO FINAL.",
      "kind": "S",
      "quantity": "60.0",
      "unit": "UNIDADE",
      "unitEstimatedValue": "666.6700",
      "totalValue": "40000.20",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 14,
      "description": "SERVIÇOS DE MAQUIADOR(A), PARA FOTO / FILMAGEM: PROFISSIONAL RESPONSÁVEL POR PREPARAR O ROSTO DAS PESSOAS POR MEIO DA APLICAÇÃO DE PRODUTOS DE BELEZA USANDO BASE, PINCÉIS, BLUSH, PÓ FACIAL, CORRETIVO, MÁSCARA DE CÍLIOS, SOMBRAS NEUTRAS E OPACAS, BATOM DE BOCA E OUTROS. JÁ INCLUINDO TRANSPORTE E ALIMENTAÇÃO (POR PESSOA).",
      "kind": "S",
      "quantity": "36.0",
      "unit": "Hora",
      "unitEstimatedValue": "550.0000",
      "totalValue": "19800.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    },
    {
      "number": 15,
      "description": "INTÉRPRETE DE LIBRAS: PROFISSIONAL TRADUTOR E INTÉRPRETE DE LIBRAS, RESPONSÁVEL POR AJUDAR NA COMUNICAÇÃO ENTRE PESSOAS OUVINTES E COM DEFICIÊNCIA AUDITIVA, OU ENTRE SURDOS, POR MEIO DA LÍNGUA BRASILEIRA DE SINAIS E A LÍNGUA ORAL CORRENTE, O PORTUGUÊS.",
      "kind": "S",
      "quantity": "36.0",
      "unit": "Hora",
      "unitEstimatedValue": "600.0000",
      "totalValue": "21600.00",
      "ncm": null,
      "judgmentCriterion": null,
      "benefitId": null,
      "benefitName": null,
      "segment": null,
      "relevance": null,
      "hasAward": null
    }
  ]

/** What every `total_value` above adds up to, to the centavo. */
export const TENDER_ITEMS_FIXTURE_TOTAL = '2988571.02'
