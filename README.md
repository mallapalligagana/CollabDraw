# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
# 🎨 CollabDraw

### Real-Time Collaborative Drawing Canvas

CollabDraw is a real-time collaborative drawing application that allows multiple users to join the same drawing room and work together on a shared canvas.

Users can draw, add shapes and text, edit existing content, and see other collaborators' changes and cursor positions in real time.

---

## ✨ Features

### 🎨 Drawing Tools

- Freehand brush
- Eraser
- Multiple brush styles
- Adjustable brush size
- Custom colors
- Advanced brush effects
- Bucket fill
- Undo / Redo
- Clear canvas

### 🔷 Shapes

Supports a variety of shapes including:

- Line
- Curve
- Rectangle
- Rounded rectangle
- Circle
- Ellipse
- Triangle
- Right triangle
- Diamond
- Pentagon
- Hexagon
- Star
- Arrow
- Double arrow
- Callout
- Cloud
- Heart
- Polygon

### 📝 Text Tool

- Add text to the canvas
- Edit existing text
- Edit text multiple times
- Drag text anywhere on the canvas
- Left / Center / Right alignment
- Bold
- Italic
- Underline
- Font selection
- Font size selection
- Text color
- Preserve text formatting while editing

### 🔄 Transformations

- Rotate left
- Rotate right
- Rotate 180°
- Custom rotation
- Flip horizontally
- Flip vertically

### 👥 Real-Time Collaboration

- Create drawing rooms
- Join existing rooms
- Leave rooms
- Real-time drawing synchronization
- Real-time text synchronization
- Real-time shape synchronization
- Live collaborator cursors
- User names
- User colors
- Active user count
- Connection status
- Reconnection handling

### 📱 Responsive UI

The application is designed to work across:

- Mobile devices
- Tablets
- Laptops
- Desktop screens

Touch-friendly interactions are supported for smaller screens.

---

## 🛠️ Tech Stack

### Frontend

to run:npm run dev
- React
- TypeScript
- Vite
- Tailwind CSS
- HTML5 Canvas
- Socket.IO Client

### Backend

to run:npm run server:dev
- Node.js
- TypeScript
- Express
- Socket.IO

### Development Tools

- ESLint
- Git
- GitHub
- npm

---

## 🏗️ Architecture

CollabDraw follows a client-server architecture.

```text
                    ┌─────────────────────┐
                    │      User 1         │
                    │   React Frontend    │
                    └──────────┬──────────┘
                               │
                               │ Socket.IO
                               │
                               ▼
                    ┌─────────────────────┐
                    │    Node.js Server   │
                    │ Express + Socket.IO  │
                    └──────────┬──────────┘
                               │
                               │ Socket.IO
                               │
                               ▼
                    ┌─────────────────────┐
                    │      User 2         │
                    │   React Frontend    │
                    └─────────────────────┘
### Deployment Note

The backend is deployed on Render's free hosting tier. When the service has been inactive for some time, it may enter a sleeping state. The first request after inactivity can therefore take longer while the service starts up.

Once the backend is active, subsequent requests and Socket.IO connections operate normally.