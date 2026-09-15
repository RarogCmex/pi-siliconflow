# pi-siliconflow

Провайдер [SiliconFlow](https://siliconflow.cn) для pi coding agent.

Один API-ключ даёт доступ к каталогу открытых моделей (DeepSeek, GLM, Kimi, Qwen,
LongCat, Step, Ling, Seed) через OpenAI-совместимый эндпоинт
`https://api.siliconflow.cn/v1`.

Расширение регистрирует `siliconflow` как полноценный нативный провайдер pi-ai
(`createProvider`), а не как legacy-конфиг: поддерживаются `/login`, живой каталог
моделей и настоящие параметры рассуждений SiliconFlow.

## Установка

```bash
pi install ~/pi-plugins/pi-siliconflow
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

## Модели

Каталог — 21 модель, проверенная по публичным страницам SiliconFlow. Живое
обнаружение (`GET /v1/models?sub_type=chat`) дополняет его моделями, которые
появились позже: pi сливает оверлей по id, сохраняет его в своём ModelsStore и
восстанавливает офлайн. Оверлей только добавляет — частичный или упавший ответ
не может оставить провайдера без моделей.

| Модель | Контекст | Макс. вывод | Картинки | Рассуждения | ¥ в/исх/кэш |
|---|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V4-Flash` | 1M | 384K | | `reasoning_effort` high/max | ¥3/¥9/¥0.3 |
| `deepseek-ai/DeepSeek-V4-Pro` | 1M | 384K | | `reasoning_effort` high/max | ¥12/¥24/¥1 |
| `deepseek-ai/DeepSeek-V3.2` | 160K | 160K | | `enable_thinking` + `thinking_budget` | ¥4/¥6/¥0.4 |
| `Pro/deepseek-ai/DeepSeek-V3.2` | 160K | 160K | | `enable_thinking` + `thinking_budget` | ¥4/¥6/¥0.4 |
| `deepseek-ai/DeepSeek-V3.1-Terminus` | 160K | 160K | | `enable_thinking` + `thinking_budget` | ¥4/¥12/¥0.4 |
| `Pro/deepseek-ai/DeepSeek-V3.1-Terminus` | 160K | 160K | | `enable_thinking` + `thinking_budget` | ¥4/¥12/¥0.4 |
| `zai-org/GLM-5.3` | 1M | 128K | | `reasoning_effort` low/high/max | ¥8/¥28/¥2 |
| `zai-org/GLM-5.2` | 1M | 128K | | `reasoning_effort` low/high/max | ¥8/¥28/¥2 |
| `Pro/zai-org/GLM-5.1` | 200K | 128K | | `reasoning_effort` low/high/max | ¥6/¥24/¥1.3 † |
| `zai-org/GLM-4.5-Air` | 128K | 128K | | `enable_thinking` | ¥1/¥6/¥0 |
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
  `Qwen/Qwen3.8-27B`, `tencent/Hy4-preview`. Живое обнаружение их покажет — с
  консервативными значениями (32K контекст, 4K вывод, нулевая цена), чтобы
  выдуманное число не портило отчёты о стоимости и не ломало компакцию.

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
| `supportsReasoningEffort` | по модели | автодетект дал бы `true` всем, и Qwen-моделям улетело бы `reasoning_effort: "medium"` |
| `thinkingTokenBudgetField` | `thinking_budget` (только Qwen/DeepSeek V3.x) | задокументирован; никогда не совмещается с `reasoning_effort` |

`supportsUsageInStreaming` и `supportsFinishReason` оставлены в (верных) значениях
по умолчанию — без них не будет ни учёта токенов, ни причины остановки.

## Разработка

```bash
npm run typecheck   # tsc -p tsconfig.json
npm test            # node --test (92 теста, без сети)
```

Модули разложены так, чтобы почти всё тестировалось обычным Node:

| Файл | Содержимое |
|---|---|
| `catalog.ts` | данные: id, контекст, вывод, модальности, цены в CNY, режим рассуждений |
| `models.ts` | конвертация в `Model` pi: валюта, ступени, compat, уровни |
| `discovery.ts` | живой оверлей `GET /v1/models` |
| `errors.ts` | переписывание opaque-401 |
| `provider.ts` | сборка провайдера и auth |
| `index.ts` | точка входа pi: `message_end` + `registerProvider` |

`index.ts` — единственное место с импортом, который разрешается только внутри pi:
загрузчик расширений aliases'ит голый спецификатор `@earendil-works/pi-ai` на
compat-точку входа (строгое надмножество основной), откуда и берётся
`openAICompletionsApi`. Подпути вроде `/api/openai-completions.lazy` не
alias'ятся, поэтому такой импорт прошёл бы тайпчек, но упал бы в рантайме.
`tsconfig.json` повторяет этот alias через `paths`, чтобы тайпчек видел то же,
что видит pi.

Для тайпчека нужны симлинки (вне гита):

```bash
mkdir -p node_modules/@earendil-works node_modules/@types
ln -sfn ~/.local/lib/node_modules/@earendil-works/pi-coding-agent \
  node_modules/@earendil-works/pi-coding-agent
ln -sfn ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai \
  node_modules/@earendil-works/pi-ai
ln -sfn ~/pi-plugins/pi-alibaba-models/node_modules/@types/node \
  node_modules/@types/node
```

### Что покрыто тестами

- **Формат запроса** (`test/wire-format.test.ts`) — самое важное: гоняет настоящий
  `openai-completions` адаптер pi и перехватывает тело запроса через `onPayload`,
  без единого сетевого вызова. Проверяет `enable_thinking` / `reasoning_effort` /
  `thinking_budget`, `max_tokens`, роль `system`, отсутствие `strict` / `store` /
  `prompt_cache_retention`, и что внутренние имена уровней pi (`medium`, `xhigh`)
  никогда не утекают в шлюз — по всем 21 модели и всем 6 уровням.
- **Инваранты каталога** — уникальность id, не-нулевые цены, ступени дороже базы,
  контекст ≥ вывода, точечная сверка спецификаций флагманов.
- **Конвертация валют** — точность, округление, переопределение курса, откат на
  значение по умолчанию при мусоре.
- **Обнаружение** — разбор битых ответов (включая голую строку `"Api key is
  invalid"`), фильтрация модальностей, отсутствие ключа, `allowNetwork: false`,
  abort, 401, сетевой сбой.
- **Auth** — приоритет сохранённого ключа над env, обрезка, отказ на пустом ключе,
  отмена по сигналу.
- **Переписывание ошибок** — против настоящих `isRetryableAssistantError` и
  `isContextOverflow` из pi.

### Что проверить с живым ключом

Ключ, доступный при написании, был исчерпан, поэтому запросы доходили до шлюза и
получали 401, но успешный ответ не наблюдался. Стоит подтвердить первым же
живым запросом:

1. `stream_options: { include_usage: true }` принимается (нужно для учёта токенов;
   в справочнике не документировано, но примеры SiliconFlow защищаются от чанка
   без `choices`, что намекает на поддержку).
2. Сообщения о переполнении контекста распознаются pi — если нет, добавить
   `message_end`-нормализацию по образцу из `docs/custom-provider.md`.
3. Фактические цены в ответе совпадают с каталогом.
