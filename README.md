# pi-siliconflow

Провайдер [SiliconFlow](https://siliconflow.cn) для [pi](https://github.com/earendil-works/pi)
coding agent. npm-имя пакета — `@rarogcmex/pi-siliconflow`.

SiliconFlow — китайский хостинг открытых моделей (DeepSeek, GLM, Kimi, Qwen,
LongCat, Step, Ling, Seed) с OpenAI-совместимым эндпоинтом
`https://api.siliconflow.cn/v1`. **Нужен платный аккаунт на `.cn` с балансом в
CNY**: один API-ключ даёт доступ к каталогу, а списание идёт с юанёвого баланса.
Бесплатного уровня у этих моделей нет; цены в таблицах ниже — реальные, из
листинга шлюза.

> Этот README — на русском; комментарии в коде и пользовательские строки
> рантайма — на английском (за исключением одного персистентного сообщения об
> ошибке авторизации, см. «Обработка ошибок»).

Расширение регистрирует `siliconflow` как полноценный нативный провайдер pi-ai
(`createProvider`), а не как legacy-конфиг: поддерживаются `/login`, полудинамический
каталог (кураторская таблица + семейные эвристики для новых id) и настоящие
параметры рассуждений SiliconFlow. Требуется pi **0.86+** для per-model
оверрайдов компакшена и **0.87+** для границы `turn_end`, на которой extension
ставит персистентную подсказку; на более старом pi расширение загрузится, но эти
две возможности молча не сработают.

Код под OpenAI Responses API **есть, но выключен** (`RESPONSES_ENABLED = false`
в `models.ts`). Публичный шлюз SiliconFlow отвечает `404` на
`POST /v1/responses` (проверено 2026-09-19 и повторно живым запросом 2026-09-23
на `.cn`); их же гайд по Codex велит мостить протоколы через
[CC Switch](https://github.com/farion1231/cc-switch). Пока
флаг выключен, живой провайдер регистрирует только `openai-completions` — случайный
`api: "openai-responses"` падает закрыто, а не уходит в SDK на 404. Конверсия,
compat, семейный роутинг и тесты остаются в дереве: когда они запилят роут,
достаточно переключить константу.

### Anthropic Messages (`/v1/messages`): известная альтернатива, не переключаемся

Шлюз официально принимает и Anthropic-протокол `POST /v1/messages`
(`x-api-key` + `anthropic-version`, спека —
<https://api-docs.siliconflow.cn>). Пробы 2026-09-23 подтвердили system,
`thinking: {type: disabled|enabled, budget_tokens}`, streaming и длинные диалоги
(заявленное в их OpenAPI-схеме `maxItems: 10` фактически не ограничивает длину).

Расширение остаётся на completions, потому что Messages даёт **паритет, а не
выигрыш**, с одной реальной регрессией: в Anthropic-протоколе рассуждения
управляются только `budget_tokens`, поэтому флагманские DeepSeek-V4 / GLM-5.x
потеряли бы селектор усилия (`reasoning_effort` low/high/max), который даёт
`thinkingLevelMap`. pi и так полностью раскладывает `reasoning_content` из
completions в ThinkingContent, так что отображение рассуждений совпадает.
Overflow-ошибка приходит тем же не-OpenAI конвертом `{"code":20015,…}` —
ремедиацию пришлось бы перепроверять под anthropic-адаптер pi.

Если completions начнёт деградировать — Messages готовый запасной маршрут с
зафиксированными выше ограничениями.

## Установка

```bash
pi install git:github.com/RarogCmex/pi-siliconflow@main
# или локально
pi install /path/to/pi-siliconflow
```

## Авторизация

Два способа:

1. **Интерактивный логин** — ключ сохраняется в `~/.pi/agent/auth.json`:
   - в сессии pi выполните `/login siliconflow` и вставьте ключ;
   - поле ввода секретное, перед ним показывается ссылка на
     <https://cloud.siliconflow.cn/account/ak>.

2. **Переменная окружения**:
   ```bash
   export SILICONFLOW_API_KEY=sk-...
   ```

Приоритет: сохранённый ключ (`auth.json`) → переменная окружения.
Пробельные символы обрезаются на обоих путях: ключ, вставленный с переводом
строки, отклоняется шлюзом той же opaque-ошибкой 401, что и отозванный ключ, и
без обрезки это выглядит как проблема с аккаунтом.

Выход: `/logout siliconflow`.

### Понятная ошибка вместо `401 status code (no body)`

SiliconFlow возвращает ошибки не в OpenAI-конверте (`{"code":20012,...}` или вовсе
голую JSON-строку `"Api key is invalid"`), поэтому адаптер pi не может показать
тело ответа, и мёртвый ключ выглядит как `401 status code (no body)`.

Расширение перехватывает `message_end` и переписывает именно этот случай в
читаемый текст с указанием обеих реальных причин (недействительный ключ **или**
исчерпанный баланс — шлюз отвечает на них одинаково). Переписывание узкое: только
401/402/403 без тела, только этот провайдер. Формулировка проверена тестами
против настоящих классификаторов pi, поэтому она не превращает постоянную ошибку
в цикл ретраев и не запускает компакцию контекста.

Дополнительно (pi 0.87+): `turn_end` как actionable boundary добавляет persistent
`custom_message` (`siliconflow-auth-help`, `display: true`) со ссылкой на
https://cloud.siliconflow.cn/account/ak и подсказкой `/login siliconflow`.
Переписывание в `message_end` — транзиентное (только в бабле ошибки), а entry
в `turn_end` остаётся в истории и не теряется при скролле. На error-исходах
`continue` сознательно не выставляется — это hard exit.

### Переполнение контекста: возврат утраченного тела ошибки

Проверено живым запросом (2026-09-23): шлюз отвергает слишком большой промпт
HTTP 400 с телом `{"code":20015,"message":"number of input tokens (300030) has
exceeded max_prompt_tokens (98304) limit.","data":null}`. OpenAI SDK собирает
сообщение об ошибке только из конверта `error.message` (в нём `errJSON ?
undefined : errText`), поэтому это тело — валидный JSON без `error` — выбрасывается
и pi видит `400 status code (no body)`, который классификатор переполнения не
распознаёт (тело-без-статуса он приписывает только Cerebras).

Расширение цепляет собственный `fetch` к обеим API-поверхностям
(`withOverflowRemediation` в `provider.ts`): ответ 400/413 с сообщением,
которое `normalizeOverflowError` считает переполнением, переупаковывается в
plain text — тогда SDK просто вставляет текст в сообщение как
`400 <message>`, `message_end` переписывает его в `context_length_exceeded:`
и pi запускает авто-компакшен. Всё остальное (включая 401 «Api key is invalid»)
проходит без изменений: их путь непрозрачных ошибок уже описан и протестирован
разделом выше. Обе наблюдаемые формулировки шлюза покрыты: `max_prompt_tokens`
(GLM-4.5-Air) и `max_seq_len` (Ling-flash-2.0, общее окно промпт+вывод = 131072).

Полный прогон можно повторить: `node live/check.ts` (запрашивает живой ключ из
`~/.pi/agent/auth.json` или `SILICONFLOW_API_KEY`; осознанно тратит копейки на
4 коротких запроса и один переполняющий).

Живой кейс конца-в-конец (проверено через настоящий `pi -p`): промпт на 129K
токенов против GLM-4.5-Air → pi показал `context_length_exceeded: 400 number
of input tokens (129470) has exceeded max_prompt_tokens (98304) limit.` и
запустил recover-компакшен — всё звено ремедиации работает. Известное
ограничение самого pi, не расширения: если переполнение создано **одним**
сообщением больше окна, саммаризация «turn prefix» отправляет это же сообщение
модели целиком и тоже упирается в 400 — восстановление честно падает с понятной
ошибкой. Многоходовые сессии до этого не доходят: компакшен по окну из каталога
запускается заранее.

## Модели

Каталог — 21 модель, проверенная по публичным страницам SiliconFlow. Это
**полудинамический** каталог: кураторская таблица
держит измеренные окна, цены и параметры рассуждений, а живое обнаружение
(`GET /v1/models?sub_type=chat`) добавляет id, которых в таблице ещё нет.

- Известные id **не** перезаписываются оверлеем — иначе вчерашний курс юаня и
  окна заморозились бы в ModelsStore и переживали бы правку `catalog.ts`.
- Неизвестные id классифицируются по семье (DeepSeek V3/V4, GLM-4.5/5, Qwen 3.5+,
  Kimi K2): те же thinking/vision/окна, что у соседей, цена 0.
- Неузнанные семьи — консервативно (32K контекст, 4K вывод, без рассуждений,
  цена 0), чтобы выдуманное число не портило отчёты и не ломало компакцию.
- Оверлей только добавляет: частичный или упавший ответ не может оставить
  провайдера без моделей. pi сохраняет его в ModelsStore и восстанавливает офлайн.

| Модель | Контекст | Макс. вывод | Картинки | Рассуждения | ¥ в/исх/кэш |
|---|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V4-Flash` | 1M | 384K | | `reasoning_effort` high/max | ¥3/¥9/¥0.3 |
| `deepseek-ai/DeepSeek-V4-Pro` | 1M | 384K | | `reasoning_effort` high/max | ¥12/¥24/¥1 |
| `deepseek-ai/DeepSeek-V3.2` | 160K | 160K | | `enable_thinking` + `thinking_budget` | ¥4/¥6/¥0.4 |
| `Pro/deepseek-ai/DeepSeek-V3.2` | 160K | 160K | | `enable_thinking` + `thinking_budget` | ¥4/¥6/¥0.4 |
| `deepseek-ai/DeepSeek-V3.1-Terminus` | 160K | 160K | | `enable_thinking` + `thinking_budget` § | ¥4/¥12/¥0.4 |
| `Pro/deepseek-ai/DeepSeek-V3.1-Terminus` | 160K | 160K | | `enable_thinking` + `thinking_budget` § | ¥4/¥12/¥0.4 |
| `zai-org/GLM-5.3` | 1M | 128K | | `reasoning_effort` low/high/max | ¥8/¥28/¥2 |
| `zai-org/GLM-5.2` | 1M | 128K | | `reasoning_effort` low/high/max | ¥8/¥28/¥2 |
| `Pro/zai-org/GLM-5.1` | 200K | 128K | | `reasoning_effort` low/high/max | ¥6/¥24/¥1.3 † |
| `zai-org/GLM-4.5-Air` | 96K ‡ | 32K ‡ | | `enable_thinking` | ¥1/¥6/¥0 |
| `moonshotai/Kimi-K2.7-Code` | 256K | 256K | ✓ | всегда включены | ¥6.5/¥27/¥1.3 |
| `Pro/moonshotai/Kimi-K2.6` | 256K | 256K | ✓ | всегда включены | ¥6.5/¥27/¥1.1 |
| `Qwen/Qwen3.6-27B` | 256K | 256K | ✓ | `enable_thinking` + `thinking_budget` | ¥3/¥18/¥0 |
| `Qwen/Qwen3.6-35B-A3B` | 256K | 256K | ✓ | `enable_thinking` + `thinking_budget` | ¥1.8/¥10.8/¥0 |
| `Qwen/Qwen3.5-122B-A10B` | 256K | 256K | ✓ | `enable_thinking` + `thinking_budget` | ¥0.8/¥6.4/¥0 † |
| `Qwen/Qwen3.5-35B-A3B` | 256K | 256K | ✓ | `enable_thinking` + `thinking_budget` | ¥0.4/¥3.2/¥0 † |
| `Qwen/Qwen3.5-27B` | 256K | 256K | ✓ | `enable_thinking` + `thinking_budget` | ¥0.6/¥4.8/¥0 † |
| `meituan-longcat/LongCat-2.0` | 1M | 128K | | — | ¥5/¥20/¥0.1 |
| `stepfun-ai/Step-3.5-Flash` | 256K | 64K | | — | ¥0.7/¥2.1/¥0 |
| `inclusionAI/Ling-flash-2.0` | 128K | 128K | | — | ¥1/¥4/¥0 |
| `ByteDance-Seed/Seed-OSS-36B-Instruct` | 256K | 256K | | — | ¥1.5/¥4/¥0 |

† Ступенчатая цена по размеру входа: `Pro/zai-org/GLM-5.1` — свыше 32k токенов
¥8/¥28/¥2; `Qwen/Qwen3.5-122B-A10B` — свыше 128k ¥2/¥16; `Qwen/Qwen3.5-35B-A3B` —
свыше 128k ¥1.6/¥12.8; `Qwen/Qwen3.5-27B` — свыше 128k ¥1.8/¥14.4. Передано в pi
через `cost.tiers`.

‡ Спека модели обещает 128K, но шлюз держит `max_prompt_tokens = 98 304`
(измерено живым запросом 2026-09-23: 300 030 токенов → 400 «max_prompt_tokens
(98304) limit»). 98 304 токена — это 96K в тех же двоичных единицах, в которых
считаны остальные ячейки таблицы (160K = 163 840, 128K = 131 072, 1M =
1 048 576). В каталоге стоят измеренные `contextWindow: 98 304` и
`maxTokens: 32 768`: завышение окна лишь откладывало бы компакшен до уже
невозможного запроса, и каждая длинная сессия спотыкалась бы об один и тот же
400.

§ По докам SiliconFlow `DeepSeek-V3.1` с function calling требует
`enable_thinking: false`. pi как агент всегда шлёт `tools`, поэтому расширение
через `before_provider_request` форсит `enable_thinking: false` (и убирает
`thinking_budget`/`reasoning_effort`) именно когда в запросе есть tools.
Без tools thinking работает как обычно.

Выбор модели: `/model` внутри pi, либо
`pi --model siliconflow/deepseek-ai/DeepSeek-V4-Flash`, уровень размышлений —
`pi --model "siliconflow/zai-org/GLM-5.3:max"`.

### Намеренно не включены

- **Deprecated** по данным страниц моделей: `zai-org/GLM-4.5V`,
  `THUDM/GLM-4-32B-0414`, `inclusionAI/Ling-mini-2.0`.
- **Без поддержки инструментов**: `tencent/Hunyuan-A13B-Instruct` — непригоден для
  агента.
- **Не чат**: эмбеддинги, реранкеры, изображение, аудио, видео, OCR.
- **Продаётся на .cn, но без публичной страницы спецификаций**:
  `Qwen/Qwen3.8-27B`, `tencent/Hy4-preview`, `XingChenAGI/Xing4.0-29B`. Живое
  обнаружение их покажет: Qwen 3.8 унаследует семейную эвристику (256K,
  `enable_thinking` + `thinking_budget`, зрение, цена 0); Hy4-preview и Xing4.0
  останутся консервативными 32K/4K без рассуждений.

### Компакшен

По умолчанию pi держит `reserveTokens=16384` и `keepRecentTokens=20000` для всех
моделей. Для 1M-моделей каталога (`DeepSeek-V4-Flash/Pro`, `zai-org/GLM-5.3/5.2`,
`meituan-longcat/LongCat-2.0`) это срабатывает слишком поздно: порог
`contextWindow - reserveTokens` почти упирается в лимит, а саммаризация
гигантского контекста дорогая.

С pi 0.86+ настройте per-model оверрайды в `~/.pi/agent/settings.json`
(или `<project>/.pi/settings.json`):

```json
{
  "compaction": {
    "modelOverrides": {
      "siliconflow/deepseek-ai/DeepSeek-V4-Flash": { "reserveTokens": 64000, "keepRecentTokens": 40000 },
      "siliconflow/deepseek-ai/DeepSeek-V4-Pro": { "reserveTokens": 64000, "keepRecentTokens": 40000 },
      "siliconflow/zai-org/GLM-5.3": { "reserveTokens": 64000, "keepRecentTokens": 40000 },
      "siliconflow/zai-org/GLM-5.2": { "reserveTokens": 64000, "keepRecentTokens": 40000 },
      "siliconflow/meituan-longcat/LongCat-2.0": { "reserveTokens": 64000, "keepRecentTokens": 40000 }
    }
  }
}
```

Это раньше запускает компакшен (при ~985K вместо ~1032K: окно 1M-моделей —
`1 048 576`, порог — `contextWindow − reserveTokens`) и оставляет больше
свежего контекста для кодинга. Для 128–256K моделей дефолтов достаточно.

## Цены и валюта

`cost` в pi — это **доллары за миллион токенов**, а SiliconFlow `.cn` тарифицирует
в **юанях**. Каталог хранит цены в CNY (ровно так, как их показывает
<https://siliconflow.cn/pricing>), а конвертация делается в `models.ts`.

Курс по умолчанию — `6.7252` CNY/USD (среднерыночный на 2026-09-15,
open.er-api.com). Встроенные китайские провайдеры самого pi используют ~6.8, так
что значение в семействе. Курс меняется, поэтому он переопределяется без правки
кода:

```bash
export SILICONFLOW_CNY_PER_USD=7.1
```

Два осознанных решения по ценам:

- **Пиковый тариф, а не ночной.** У `DeepSeek-V4-Flash` цена зависит от времени
  суток: 02:00–08:00 CST вдвое дешевле (¥1.50/¥4.50/¥0.15 против ¥3/¥9/¥0.30).
  pi не умеет в тарификацию по часам, поэтому взят стандартный 22-часовой тариф —
  стоимость никогда не занижается. Ночью реальные расходы будут примерно вдвое
  ниже показанных.
- **`cacheWrite` всегда 0.** SiliconFlow публикует только цену чтения из кэша.

Эндпоинт `api.siliconflow.com` (международный) имеет собственный прайс-лист в USD,
который не совпадает с `.cn` даже после конвертации. Цены в этом каталоге описывают
только `.cn`.

Вдобавок `.com` официально сворачивается: по release notes SiliconFlow
«api.siliconflow.com will be phased out… switch to api.siliconflow.cn as soon as
possible» — на `.cn` поднят Global Traffic Manager с тем же глобальным доступом.
Расширение с самого начала целиком нацелено на `.cn` (дефолтный baseUrl, CNY-цены,
все живые проверки — только `.cn`) и не поддерживает `.com`: если вы всё же
укажете его через `SILICONFLOW_BASE_URL`, цены каталога будут неточны, а
платформа рекомендует мигрировать в любом случае.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `SILICONFLOW_API_KEY` | Ключ, если не используется `/login` |
| `SILICONFLOW_BASE_URL` | Замена эндпоинта (прокси, зеркало) |
| `SILICONFLOW_CNY_PER_USD` | Курс для пересчёта цен |

## Почему compat-флаги заданы явно

pi определяет OpenAI-совместимость по URL провайдера. `api.siliconflow.cn` не
попадает ни под одно правило, поэтому автодетект дал бы vanilla-OpenAI профиль,
неверный в четырёх местах. Все флаги выставлены вручную и проверены тестом,
который прогоняет запрос через настоящий адаптер pi и смотрит на итоговые байты:

| Флаг | Значение | Причина |
|---|---|---|
| `maxTokensField` | `max_tokens` | в справочнике API только он, не `max_completion_tokens` |
| `thinkingFormat` | `qwen` | SiliconFlow переключает рассуждения топ-уровневым `enable_thinking: bool` |
| `supportsDeveloperRole` | `false` | документированы только `system`/`user`/`assistant`/`tool` |
| `supportsStrictMode` | `false` | на всех страницах моделей «Structured Outputs: Not supported» |
| `supportsStore`, `supportsLongCacheRetention`, `supportsOpenAIGrammarTools` | `false` | этих полей нет в справочнике — не отправляем |
| `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText` | `false` | шлюз принимает стандартную OpenAI-форму: `name` в tool-результате не требуется, assistant-сообщение между tool-вызовом и результатом не нужно, рассуждения приходят отдельным `reasoning_content`, а не текстом |
| `supportsReasoningEffort` | по модели | автодетект дал бы `true` всем, и Qwen-моделям улетело бы `reasoning_effort: "medium"` |
| `thinkingTokenBudgetField` | `thinking_budget` (только Qwen/DeepSeek V3.x) | задокументирован; никогда не совмещается с `reasoning_effort` |

`supportsUsageInStreaming` и `supportsFinishReason` оставлены в (верных) значениях
по умолчанию — без них не будет ни учёта токенов, ни причины остановки.

## Разработка

```bash
npm run typecheck   # tsc -p tsconfig.json
npm test            # node --test (129 тестов, без сети)
node live/check.ts  # живые проверки шлюза (6 шт., требует ключ, тратит копейки)
```

Модули разложены так, чтобы почти всё тестировалось обычным Node:

| Файл | Содержимое |
|---|---|
| `catalog.ts` | данные: id, контекст, вывод, модальности, цены в CNY, режим рассуждений, опциональный `api` |
| `models.ts` | конвертация в `Model` pi: валюта, ступени, compat, уровни, семейные эвристики для неизвестных id |
| `discovery.ts` | полудинамический оверлей `GET /v1/models` (unknowns-only, family-guessed) |
| `errors.ts` | переписывание opaque-401, overflow → `context_length_exceeded`, извлечение тела ошибки шлюза и его ремедиация (plain-text Response), фикс V3.1 thinking |
| `provider.ts` | сборка провайдера, auth, карта API (`openai-responses` опционален), `withOverflowRemediation` — fetch-обёртка |
| `index.ts` | точка входа pi: `message_end` + actionable `turn_end` + `before_provider_request` + `registerProvider` |
| `test/` | офлайн-тесты (без сети): wire-format через настоящий адаптер pi, инварианты каталога, конвертация валют, обнаружение, auth, ошибки, обёртка |
| `live/check.ts` | живые проверки шлюза (сеть + ключ): список моделей, usage в стриме, reasoning-параметры, V3.1 tool call, переполнение |

`node --test` забирает только `test/*.ts` — `live/check.ts` в прогон не попадает и
запускается явно.

`index.ts` — единственное место с импортом, который разрешается только внутри pi:
загрузчик расширений aliases'ит голый спецификатор `@earendil-works/pi-ai` на
compat-точку входа (строгое надмножество основной), откуда и берутся
`openAICompletionsApi` / `openAIResponsesApi`. Подпути вроде
`/api/openai-completions.lazy` не alias'ятся, поэтому такой импорт прошёл бы
тайпчек, но упал бы в рантайме.
`tsconfig.json` повторяет этот alias через `paths`, чтобы тайпчек видел то же,
что видит pi.

Для тайпчека нужны пакеты самого pi — они не объявлены зависимостями (в рантайме
их подменяет загрузчик расширений pi), поэтому их линкует отдельный скрипт:

```bash
node scripts/link-pi.mjs
```

Он сам находит глобальную установку pi — префикс npm, nvm, pnpm, `~/.local`,
`/usr/local` или каталог, куда резолвится исполняемый `pi`, — и создаёт симлинки
(на Windows — junctions). Для конкретной установки:
`PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`. Проверено на
pi 0.87.1 / pi-ai 0.87.1 / `@types/node` 22.19.19.

### Что покрыто тестами

- **Формат запроса** (`test/wire-format.test.ts`) — самое важное: гоняет настоящий
  `openai-completions` адаптер pi и перехватывает тело запроса через `onPayload`,
  без единого сетевого вызова. Проверяет `enable_thinking` / `reasoning_effort` /
  `thinking_budget`, `max_tokens`, роль `system`, отсутствие `strict` / `store` /
  `prompt_cache_retention`, и что внутренние имена уровней pi (`medium`, `xhigh`)
  никогда не утекают в шлюз — по всем 21 модели и всем 6 уровням.
- **Инварианты каталога** — уникальность id, не-нулевые цены, ступени дороже базы,
  контекст ≥ вывода, точечная сверка спецификаций флагманов.
- **Конвертация валют** — точность, округление, переопределение курса, откат на
  значение по умолчанию при мусоре.
- **Обнаружение** — разбор битых ответов (включая голую строку `"Api key is
  invalid"`), фильтрация модальностей, семейные эвристики для неизвестных id,
  отсутствие ключа, `allowNetwork: false`, abort, 401, сетевой сбой.
- **Диспетчер API** — `RESPONSES_ENABLED` выключен; `buildApiMap` не кладёт
  Responses-адаптер; dormant-путь (синтетическая модель → `/v1/responses`)
  покрыт тестом и не регистрируется в живом провайдере.
- **Auth** — приоритет сохранённого ключа над env, обрезка, отказ на пустом ключе,
  отмена по сигналу.
- **Переписывание ошибок** — против настоящих `isRetryableAssistantError` и
  `isContextOverflow` из pi, включая байт-в-байт реальные тела 400-х шлюза
  (обе формулировки переполнения) и полную цепочку «ремедиация → SDK →
  классификатор pi».
- **Fetch-обёртка ремедиации** (`withOverflowRemediation`) — инъекция fetch в обе
  точки делегирования, сцепление с caller-fetch без замены, идемпотентность
  маркером, сквозная ремедиация 400/413 с overflow-телом при passthrough 200-х
  и чужих ошибок.

### Проверено с живым ключом (2026-09-23)

Что шлюз действительно принимает — по шести проверкам `live/check.ts`, все PASS.
Перечислены только устойчивые следствия для пользователя; журнал сессии, счётчики
токенов и ход отладки здесь намеренно не приводятся.

- **`stream_options: { include_usage: true }` принимается.** Usage приходит в
  стриме: вход, выход и `reasoning_tokens` (через
  `completion_tokens_details.reasoning_tokens`) учитываются, стоимость pi считает
  по ценам каталога.
- **Переполнение контекста распознаётся pi.** Шлюз отвечает осмысленным телом,
  но OpenAI SDK его выбрасывает (нет конверта `error.message`), поэтому без
  вмешательства pi видит `400 (no body)`. Расширение переупаковывает ответ в
  `fetch`-обёртке; обе формулировки шлюза (`max_prompt_tokens` и `max_seq_len`)
  воспроизведены живьём и покрыты тестами. См. «Переполнение контекста» выше.
- **`fixV31ThinkingPayload` работает.** DeepSeek-V3.1 + tools с принудительным
  `enable_thinking: false` — живой tool-call раунд-трип проходит,
  `stopReason: toolUse`.
- **`reasoning_effort` и `thinking_budget` принимаются** (проверено на
  DeepSeek-V4-Flash и Qwen3.5-27B).
- **Каталог не устарел:** все 21 id из таблицы на шлюзе присутствуют.
  Кандидаты оверлея — в основном старые Qwen2.5/3 и LoRA-варианты плюс модели без
  публичных спецификаций; классификация семей обрабатывает их как описано.
- **Цены в ответе шлюза отсутствуют** — стоимость считает pi по каталогу, токены
  в usage совпадают с ожидаемыми.

**Известные ограничения.** Промпт-кэш на `Qwen3.5-27B` не сработал (три
идентичных запроса по ~1,5K токенов дали `cacheRead = 0`), поэтому `cacheRead`
для Qwen-семейства в каталоге нулевой. Адаптер pi при этом корректно читает
`prompt_tokens_details.cached_tokens` и `prompt_cache_hit_tokens`, так что учёт
включится сам, если кэш на стороне шлюза заработает.
