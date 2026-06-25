# Guía de contribución — Git Workflow

## Índice

1. [Regla principal](#regla-principal)
2. [Nomenclatura de ramas](#nomenclatura-de-ramas)
3. [Flujo de trabajo paso a paso](#flujo-de-trabajo-paso-a-paso)
4. [Pull Requests](#pull-requests)
5. [Revisión y merge](#revisión-y-merge)
6. [Reglas generales](#reglas-generales)

---

## Regla principal

**Nunca trabajar directamente sobre `main`.** Todo cambio entra por una rama propia y se incorpora a `main` mediante un Pull Request aprobado.

---

## Nomenclatura de ramas

El nombre de la rama debe indicar el tipo de cambio y una descripción corta en kebab-case:

| Prefijo | Cuándo usarlo | Ejemplo |
|---|---|---|
| `feat/` | Nueva funcionalidad | `feat/login-screen` |
| `fix/` | Corrección de un bug | `fix/precio-negativo` |
| `chore/` | Tareas de mantenimiento, config | `chore/actualizar-deps` |
| `docs/` | Solo documentación | `docs/readme-instalacion` |
| `refactor/` | Refactorización sin cambio funcional | `refactor/repositorio-productos` |

---

## Flujo de trabajo paso a paso

### 1. Asegurarse de tener `main` actualizado

```bash
git checkout main
git pull origin main
```

### 2. Crear la rama a partir de `main`

```bash
git checkout -b feat/nombre-de-tu-feature
```

### 3. Trabajar y hacer commits

Hacer commits pequeños y descriptivos. El mensaje debe explicar **qué** se hizo:

```bash
git add .
git commit -m "feat: agregar formulario de alta de producto"
```

Prefijos recomendados para el mensaje de commit:

| Prefijo | Uso |
|---|---|
| `feat:` | Nueva funcionalidad |
| `fix:` | Corrección de bug |
| `chore:` | Mantenimiento / config |
| `docs:` | Documentación |
| `refactor:` | Refactor sin cambio funcional |
| `style:` | Formato, espacios, sin lógica |
| `test:` | Agregar o corregir tests |

### 4. Subir la rama al repositorio remoto

```bash
git push origin feat/nombre-de-tu-feature
```

Si es la primera vez que subes esa rama, Git puede pedir que uses `--set-upstream`. En ese caso:

```bash
git push --set-upstream origin feat/nombre-de-tu-feature
```

---

## Pull Requests

Una vez que la rama está subida, se crea el Pull Request (PR) en GitHub.

1. Ir al repositorio en GitHub.
2. GitHub suele mostrar un banner "Compare & pull request" — hacer click ahí. Si no aparece, ir a **Pull Requests → New pull request**.
3. Asegurarse de que la base sea `main` y el compare sea tu rama.
4. Completar:
   - **Título**: breve y claro (`feat: agregar login con Supabase`)
   - **Descripción**: qué se hizo, por qué, y cómo probarlo
5. Asignar al menos un revisor.
6. Crear el PR.

**No mergiar el propio PR** — siempre esperar que otra persona lo revise.

---

## Revisión y merge

### Si eres el revisor

1. Leer los cambios en la pestaña **Files changed**.
2. Dejar comentarios en las líneas que lo necesiten.
3. Si todo está bien: **Approve**.
4. Si hay algo a corregir: **Request changes** con una descripción clara de qué falta.

### Mergiar

Solo se mergea cuando:
- Hay al menos una aprobación.
- No hay conflictos con `main`.

Usar **Squash and merge** para mantener el historial de `main` limpio (un commit por feature).

Después del merge, eliminar la rama desde GitHub (hay un botón "Delete branch" automático).

### Actualizar local después del merge

```bash
git checkout main
git pull origin main
git branch -d feat/nombre-de-tu-feature   # elimina la rama local
```

---

## Reglas generales

- Una rama = una funcionalidad o fix. No mezclar cosas.
- Commitear seguido, no acumular todos los cambios en un solo commit enorme.
- Si `main` avanzó mientras trabajabas en tu rama, actualizarla antes de pedir review:

```bash
git checkout main
git pull origin main
git checkout feat/tu-rama
git merge main
```

- Si hay conflictos al mergear, resolverlos localmente, commitear la resolución y volver a subir la rama.
- No forzar pushes (`--force`) sobre ramas que otros ya descargaron.
