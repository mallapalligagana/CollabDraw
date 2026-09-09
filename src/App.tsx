import { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

type Tool = 'brush' | 'eraser'
type CanvasTool = Tool | 'shapes' | 'fill' | 'text'
type ShapeType = 'line' | 'curve' | 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'circle' | 'triangle' | 'right-triangle' | 'diamond' | 'pentagon' | 'hexagon' | 'star' | 'arrow' | 'double-arrow' | 'callout' | 'cloud' | 'heart' | 'polygon'
type FillMode = 'none' | 'solid'
type BrushType = 'brush' | 'calligraphy-brush' | 'calligraphy-pen' | 'airbrush' | 'oil' | 'crayon' | 'marker' | 'pencil' | 'watercolour'
type Point = { x: number; y: number }
type Stroke = { points: Point[]; color: string; size: number; tool: Tool; brush: BrushType }
type ShapeCommand = { kind: 'shape'; shape: ShapeType; start: Point; end: Point; color: string; size: number; fillColor: string; fillMode: FillMode; tool: 'brush' }
type FillCommand = { kind: 'fill'; point: Point; color: string }
type TextCommand = { kind: 'text'; id: string; point: Point; text: string; color: string; fontFamily: string; fontSize: number; bold: boolean; italic: boolean; underline: boolean; align: CanvasTextAlign }
type TextUpdateCommand = { kind: 'text-update'; id: string; command: TextCommand; previous?: TextCommand }
type CanvasCommand = Stroke | ShapeCommand | FillCommand | TextCommand | TextUpdateCommand
type DrawingBatch = Stroke & { strokeId: string; complete: boolean }
type RoomUser = { id: string; name: string; color: string }
type RoomSnapshot = { id: string; users: RoomUser[] }
type CursorPosition = { x: number; y: number; visible: boolean }
type CursorUpdate = CursorPosition & RoomUser
type CanvasOperation = ShapeCommand | FillCommand | TextCommand | TextUpdateCommand
type RoomResponse = { ok: true; room: RoomSnapshot } | { ok: false; error: string }

interface ServerToClientEvents {
  'room-users': (room: RoomSnapshot) => void
  'draw-batch': (batch: DrawingBatch) => void
  'canvas-operation': (operation: CanvasOperation) => void
  'cursor-update': (cursor: CursorUpdate) => void
}

interface ClientToServerEvents {
  'create-room': (payload: { roomId: string; name: string }, callback: (response: RoomResponse) => void) => void
  'join-room': (payload: { roomId: string; name: string }, callback: (response: RoomResponse) => void) => void
  'leave-room': (callback: (response: RoomResponse) => void) => void
  'draw-batch': (batch: DrawingBatch) => void
  'canvas-operation': (operation: CanvasOperation) => void
  'cursor-move': (position: CursorPosition) => void
  'color-change': (color: string) => void
}

type CanvasSocket = Socket<ServerToClientEvents, ClientToServerEvents>

const brushSizes = { Small: 4, Medium: 10, Large: 18 } as const
const brushLabels: Record<BrushType, string> = {
  brush: 'Brush',
  'calligraphy-brush': 'Calligraphy Brush',
  'calligraphy-pen': 'Calligraphy Pen',
  airbrush: 'Airbrush',
  oil: 'Oil Brush',
  crayon: 'Crayon',
  marker: 'Marker',
  pencil: 'Natural Pencil',
  watercolour: 'Watercolour Brush',
}
type BrushSize = keyof typeof brushSizes
type RoomAction = 'idle' | 'creating' | 'joining' | 'leaving'
type TransformAction = 'flip-vertical' | 'flip-horizontal' | 'rotate-right' | 'rotate-left' | 'rotate-180'

const getRoomIdFromPath = () => {
  const match = window.location.pathname.match(/^\/room\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : ''
}

const clampColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const rgbToHex = (r: number, g: number, b: number) => `#${[r, g, b].map((channel) => clampColorChannel(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
const hexToRgb = (hex: string) => {
  const value = hex.replace('#', '')
  const expanded = value.length === 3 ? value.split('').map((character) => character + character).join('') : value
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null
  return { r: parseInt(expanded.slice(0, 2), 16), g: parseInt(expanded.slice(2, 4), 16), b: parseInt(expanded.slice(4, 6), 16) }
}
const rgbToHsv = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (max === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }
  if (hue < 0) hue += 360
  return { hue, saturation: max ? (delta / max) * 100 : 0, value: max * 100 }
}
const hsvToHex = (hue: number, saturation: number, value: number) => {
  const s = saturation / 100
  const v = value / 100
  const chroma = v * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const match = v - chroma
  const [red, green, blue] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return rgbToHex((red + match) * 255, (green + match) * 255, (blue + match) * 255)
}
const isTextCommand = (command: CanvasCommand): command is TextCommand => 'kind' in command && command.kind === 'text'
const isTextUpdateCommand = (command: CanvasCommand): command is TextUpdateCommand => 'kind' in command && command.kind === 'text-update'

function App() {
  const getTextCommand = (command: CanvasCommand | null | undefined): TextCommand | null => {
    if (!command) return null
    if (isTextUpdateCommand(command)) return command.command
    if (isTextCommand(command)) return command
    return null
  }
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const cursorLayerRef = useRef<HTMLDivElement>(null)
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  const isDrawingRef = useRef(false)
  const lastPointRef = useRef({ x: 0, y: 0 })
  const currentStrokeRef = useRef<Stroke | null>(null)
  const historyRef = useRef<CanvasCommand[]>([])
  const redoRef = useRef<CanvasCommand[]>([])
  const remoteStrokesRef = useRef<CanvasCommand[]>([])
  const remoteStrokeMapRef = useRef(new Map<string, Stroke>())
  const socketRef = useRef<CanvasSocket | null>(null)
  const pendingPointsRef = useRef<Point[]>([])
  const lastSentPointRef = useRef<Point | null>(null)
  const strokeIdRef = useRef('')
  const sendTimerRef = useRef<number | null>(null)
  const cursorTimerRef = useRef<number | null>(null)
  const pendingCursorRef = useRef<CursorPosition | null>(null)
  const cursorElementsRef = useRef(new Map<string, HTMLDivElement>())
  const [tool, setTool] = useState<Tool>('brush')
  const [canvasTool, setCanvasTool] = useState<CanvasTool>('brush')
  const [shapeType, setShapeType] = useState<ShapeType>('rectangle')
  const [fillMode, setFillMode] = useState<FillMode>('none')
  const [fillColor, setFillColor] = useState('#252525')
  const [textEditor, setTextEditor] = useState<{ point: Point } | null>(null)
  const [textDraft, setTextDraft] = useState('')
  const [textFont, setTextFont] = useState('Manrope')
  const [textSize, setTextSize] = useState(24)
  const [textBold, setTextBold] = useState(false)
  const [textItalic, setTextItalic] = useState(false)
  const [textUnderline, setTextUnderline] = useState(false)
  const [textAlign, setTextAlign] = useState<CanvasTextAlign>('left')
  const currentShapeRef = useRef<ShapeCommand | null>(null)
  const textCanvasPointRef = useRef<Point | null>(null)
  const editingTextIdRef = useRef<string | null>(null)
  const textDragRef = useRef<{ id: string; index: number; origin: Point; offset: Point; original: TextCommand; moved: boolean } | null>(null)
  const [color, setColor] = useState('#252525')
  const [isColorDialogOpen, setIsColorDialogOpen] = useState(false)
  const [colorDialogTarget, setColorDialogTarget] = useState<'stroke' | 'fill'>('stroke')
  const [draftColor, setDraftColor] = useState('#252525')
  const [draftHue, setDraftHue] = useState(0)
  const [draftBrightness, setDraftBrightness] = useState(50)
  const [draftRgb, setDraftRgb] = useState({ r: 37, g: 37, b: 37 })
  const [customColors, setCustomColors] = useState<string[]>([])
  const [brushSize, setBrushSize] = useState<BrushSize>('Medium')
  const [brushType, setBrushType] = useState<BrushType>('brush')
  const [isTransformOpen, setIsTransformOpen] = useState(false)
  const [customAngle, setCustomAngle] = useState('45')
  const [hasDrawing, setHasDrawing] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [roomId, setRoomId] = useState(getRoomIdFromPath)
  const [joinInput, setJoinInput] = useState('')
  const [roomUsers, setRoomUsers] = useState<RoomUser[]>([])
  const [roomNotice, setRoomNotice] = useState('')
  const [roomAction, setRoomAction] = useState<RoomAction>('idle')
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const [userName] = useState(() => `Guest-${Math.random().toString(36).slice(2, 7)}`)
  const roomIdRef = useRef(roomId)
  const roomUsersRef = useRef<RoomUser[]>([])
  const joinRoomRef = useRef<(requestedRoomId: string) => void>(() => undefined)

  const openColorDialog = (suggestedColor = color, target: 'stroke' | 'fill' = 'stroke') => {
    const rgb = hexToRgb(suggestedColor) ?? { r: 37, g: 37, b: 37 }
    const hsv = rgbToHsv(rgb)
    setDraftColor(suggestedColor)
    setDraftRgb(rgb)
    setDraftHue(hsv.hue)
    setDraftBrightness(hsv.value)
    setColorDialogTarget(target)
    setIsColorDialogOpen(true)
  }

  const updateDraftColor = (nextColor: string) => {
    const normalized = nextColor.startsWith('#') ? nextColor.toUpperCase() : `#${nextColor.toUpperCase()}`
    const rgb = hexToRgb(normalized)
    if (!rgb) return
    const hsv = rgbToHsv(rgb)
    setDraftColor(normalized)
    setDraftRgb(rgb)
    setDraftHue(hsv.hue)
    setDraftBrightness(hsv.value)
  }

  const updateDraftFromHsv = (hue: number, saturation: number, brightness: number) => {
    const nextColor = hsvToHex(hue, saturation, brightness)
    const rgb = hexToRgb(nextColor) ?? { r: 0, g: 0, b: 0 }
    setDraftColor(nextColor)
    setDraftRgb(rgb)
    setDraftHue(hue)
    setDraftBrightness(brightness)
  }

  const confirmColor = () => {
    if (colorDialogTarget === 'stroke') setColor(draftColor)
    else setFillColor(draftColor)
    socketRef.current?.emit('color-change', draftColor)
    setCustomColors((colors) => colors.includes(draftColor) ? colors : [...colors, draftColor].slice(-10))
    setIsColorDialogOpen(false)
    setToast({ message: `Active color set to ${draftColor}`, tone: 'success' })
  }

  const drawBrushPath = (context: CanvasRenderingContext2D, points: Point[], stroke: Stroke) => {
    if (points.length === 0) return
    const size = stroke.size
    const angle = points.length > 1 ? Math.atan2(points[points.length - 1].y - points[0].y, points[points.length - 1].x - points[0].x) : 0
    const drawPath = () => {
      context.beginPath()
      context.moveTo(points[0].x, points[0].y)
      for (const point of points.slice(1)) context.lineTo(point.x, point.y)
      if (points.length === 1) context.lineTo(points[0].x + 0.01, points[0].y + 0.01)
      context.stroke()
    }

    context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over'
    context.strokeStyle = stroke.color
    context.shadowColor = 'transparent'
    context.setLineDash([])
    context.lineCap = 'round'
    context.lineJoin = 'round'

    switch (stroke.tool === 'eraser' ? 'brush' : stroke.brush) {
      case 'calligraphy-brush':
        context.lineCap = 'butt'
        context.lineWidth = size * (0.55 + Math.abs(Math.sin(angle)) * 0.8)
        drawPath()
        break
      case 'calligraphy-pen':
        context.lineCap = 'butt'
        context.lineWidth = Math.max(1, size * (0.25 + Math.abs(Math.cos(angle)) * 0.55))
        drawPath()
        break
      case 'airbrush':
        context.globalAlpha = 0.16
        context.lineWidth = size * 0.7
        context.shadowColor = stroke.color
        context.shadowBlur = size * 1.8
        drawPath()
        context.shadowBlur = 0
        context.globalAlpha = 1
        break
      case 'oil':
        context.lineWidth = size * 1.45
        drawPath()
        context.globalAlpha = 0.3
        context.lineWidth = size * 0.65
        context.save()
        context.translate(Math.cos(angle) * 0.7, Math.sin(angle) * 0.7)
        drawPath()
        context.restore()
        context.globalAlpha = 1
        break
      case 'crayon':
        context.globalAlpha = 0.78
        context.lineWidth = size * 0.9
        context.setLineDash([size * 0.55, size * 0.35])
        drawPath()
        context.setLineDash([])
        context.globalAlpha = 1
        break
      case 'marker':
        context.globalAlpha = 0.48
        context.lineWidth = size * 1.45
        drawPath()
        context.globalAlpha = 1
        break
      case 'pencil':
        context.globalAlpha = 0.78
        context.lineWidth = Math.max(1, size * 0.3)
        context.setLineDash([1, 1.8])
        drawPath()
        context.setLineDash([])
        context.globalAlpha = 1
        break
      case 'watercolour':
        context.globalAlpha = 0.14
        context.lineWidth = size * 1.5
        context.shadowColor = stroke.color
        context.shadowBlur = size * 0.65
        drawPath()
        context.globalAlpha = 0.1
        context.lineWidth = size * 0.9
        drawPath()
        context.shadowBlur = 0
        context.globalAlpha = 1
        break
      default:
        context.lineWidth = size
        drawPath()
    }
    context.globalAlpha = 1
    context.setLineDash([])
    context.shadowBlur = 0
    context.globalCompositeOperation = 'source-over'
  }

  const drawStroke = (context: CanvasRenderingContext2D, stroke: Stroke) => {
    drawBrushPath(context, stroke.points, stroke)
  }

  const drawCommand = (context: CanvasRenderingContext2D, command: CanvasCommand) => {
    if ('kind' in command) {
      if (command.kind === 'shape') drawShape(context, command)
      else if (command.kind === 'fill') drawFill(context, command)
      else if (command.kind === 'text-update') drawText(context, command.command)
      else drawText(context, command)
    } else drawStroke(context, command)
  }

  const drawShape = (context: CanvasRenderingContext2D, shape: ShapeCommand) => {
    const left = Math.min(shape.start.x, shape.end.x)
    const top = Math.min(shape.start.y, shape.end.y)
    const width = Math.abs(shape.end.x - shape.start.x)
    const height = Math.abs(shape.end.y - shape.start.y)
    const centerX = left + width / 2
    const centerY = top + height / 2
    const path = new Path2D()
    const polygon = (sides: number, rotation = -Math.PI / 2, inner = 1) => { for (let index = 0; index < sides; index += 1) { const angle = rotation + (index * Math.PI * 2) / sides; const radiusX = width / 2 * (index % 2 && inner < 1 ? inner : 1); const radiusY = height / 2 * (index % 2 && inner < 1 ? inner : 1); if (index === 0) path.moveTo(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY); else path.lineTo(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY) } path.closePath() }
    switch (shape.shape) {
      case 'line': path.moveTo(shape.start.x, shape.start.y); path.lineTo(shape.end.x, shape.end.y); break
      case 'curve': path.moveTo(shape.start.x, shape.start.y); path.quadraticCurveTo(centerX, top - height * 0.4, shape.end.x, shape.end.y); break
      case 'rectangle': path.rect(left, top, width, height); break
      case 'rounded-rectangle': path.roundRect(left, top, width, height, Math.min(16, width / 4, height / 4)); break
      case 'ellipse': path.ellipse(centerX, centerY, width / 2, height / 2, 0, 0, Math.PI * 2); break
      case 'circle': { const diameter = Math.min(width, height); path.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2); break }
      case 'triangle': polygon(3); break
      case 'right-triangle': path.moveTo(left, top); path.lineTo(left, top + height); path.lineTo(left + width, top + height); path.closePath(); break
      case 'diamond': polygon(4, 0); break
      case 'pentagon': polygon(5); break
      case 'hexagon': polygon(6, 0); break
      case 'star': polygon(10, -Math.PI / 2, 0.45); break
      case 'arrow': path.moveTo(left, centerY - height * .18); path.lineTo(left + width * .58, centerY - height * .18); path.lineTo(left + width * .58, top); path.lineTo(shape.end.x, centerY); path.lineTo(left + width * .58, top + height); path.lineTo(left + width * .58, centerY + height * .18); path.lineTo(left, centerY + height * .18); path.closePath(); break
      case 'double-arrow': path.moveTo(left, centerY); path.lineTo(left + width * .2, top); path.lineTo(left + width * .2, centerY - height * .18); path.lineTo(shape.end.x - width * .2, centerY - height * .18); path.lineTo(shape.end.x - width * .2, top); path.lineTo(shape.end.x, centerY); path.lineTo(shape.end.x - width * .2, shape.end.y); path.lineTo(shape.end.x - width * .2, centerY + height * .18); path.lineTo(left + width * .2, centerY + height * .18); path.lineTo(left + width * .2, shape.end.y); path.closePath(); break
      case 'callout': path.rect(left, top, width, height * .7); path.moveTo(left + width * .25, top + height * .7); path.lineTo(left + width * .2, shape.end.y); path.lineTo(left + width * .42, top + height * .7); break
      case 'cloud': {
  const x = left
  const y = top
  const w = width
  const h = height

  // Start at bottom-left
  path.moveTo(x + w * 0.20, y + h * 0.78)

  // Bottom-left curve
  path.bezierCurveTo(
    x + w * 0.05, y + h * 0.78,
    x + w * 0.02, y + h * 0.58,
    x + w * 0.12, y + h * 0.48
  )

  // Left upper cloud bump
  path.bezierCurveTo(
    x + w * 0.02, y + h * 0.25,
    x + w * 0.22, y + h * 0.10,
    x + w * 0.38, y + h * 0.20
  )

  // Top middle bump
  path.bezierCurveTo(
    x + w * 0.45, y + h * 0.02,
    x + w * 0.70, y + h * 0.04,
    x + w * 0.74, y + h * 0.24
  )

  // Right upper bump
  path.bezierCurveTo(
    x + w * 0.92, y + h * 0.18,
    x + w * 1.02, y + h * 0.38,
    x + w * 0.88, y + h * 0.52
  )

  // Right side
  path.bezierCurveTo(
    x + w * 0.98, y + h * 0.68,
    x + w * 0.82, y + h * 0.82,
    x + w * 0.66, y + h * 0.76
  )

  // Bottom middle
  path.bezierCurveTo(
    x + w * 0.52, y + h * 0.90,
    x + w * 0.32, y + h * 0.90,
    x + w * 0.20, y + h * 0.78
  )

  path.closePath()
  break
}
case 'heart': {
  const x = left
  const y = top
  const w = width
  const h = height

  path.moveTo(centerX, y + h)

  // Left side of heart
  path.bezierCurveTo(
    x + w * 0.05,
    y + h * 0.62,
    x,
    y + h * 0.25,
    x + w * 0.25,
    y + h * 0.16
  )

  // Left top lobe
  path.bezierCurveTo(
    x + w * 0.40,
    y + h * 0.10,
    x + w * 0.48,
    y + h * 0.22,
    centerX,
    y + h * 0.32
  )

  // Right top lobe
  path.bezierCurveTo(
    x + w * 0.52,
    y + h * 0.22,
    x + w * 0.60,
    y + h * 0.10,
    x + w * 0.75,
    y + h * 0.16
  )

  // Right side
  path.bezierCurveTo(
    x + w * 1.00,
    y + h * 0.25,
    x + w * 0.95,
    y + h * 0.62,
    centerX,
    y + h
  )

  path.closePath()
  break
}      case 'polygon': polygon(6); break
    }
    context.save()
    context.globalCompositeOperation = 'source-over'
    context.lineWidth = shape.size
    context.strokeStyle = shape.color
    if (shape.fillMode === 'solid' && shape.shape !== 'line' && shape.shape !== 'curve') { context.fillStyle = shape.fillColor; context.fill(path) }
    context.stroke(path)
    context.restore()
  }

  const getTextFont = (command: TextCommand) => `${command.italic ? 'italic' : 'normal'} ${command.bold ? '700' : '400'} ${command.fontSize}px ${command.fontFamily}`

  const drawText = (
    context: CanvasRenderingContext2D,
    command: TextCommand
  ) => {
    context.save()

    context.font = getTextFont(command)
    context.fillStyle = command.color
    context.textAlign = command.align
    context.textBaseline = 'alphabetic'

    const metrics = context.measureText(command.text)
    const width = metrics.width
    const anchorX =
      command.align === 'center'
        ? command.point.x
        : command.align === 'right'
          ? command.point.x
          : command.point.x

    context.fillText(command.text, anchorX, command.point.y)

    if (command.underline) {
      let startX = command.point.x

      if (command.align === 'center') startX -= width / 2
      else if (command.align === 'right') startX -= width

      const underlineY = command.point.y + Math.max(2, command.fontSize * 0.12)

      context.beginPath()
      context.lineWidth = Math.max(1, command.fontSize / 14)
      context.strokeStyle = command.color
      context.moveTo(startX, underlineY)
      context.lineTo(startX + width, underlineY)
      context.stroke()
    }

    context.restore()
  }

  const findTextAtPoint = (point: Point) => {
    const context = contextRef.current
    if (!context) return null

    for (let index = historyRef.current.length - 1; index >= 0; index -= 1) {
      const command = historyRef.current[index]
      const textCommand = getTextCommand(command)
      if (!textCommand) continue

      context.save()
      context.font = getTextFont(textCommand)

      const metrics = context.measureText(textCommand.text)
      const width = metrics.width

      let left: number
      let right: number

      if (textCommand.align === 'center') {
        left = textCommand.point.x - width / 2
        right = textCommand.point.x + width / 2
      } else if (textCommand.align === 'right') {
        left = textCommand.point.x - width
        right = textCommand.point.x
      } else {
        left = textCommand.point.x
        right = textCommand.point.x + width
      }

      const ascent = metrics.actualBoundingBoxAscent || textCommand.fontSize
      const descent = metrics.actualBoundingBoxDescent || textCommand.fontSize * 0.25
      const padding = Math.max(8, textCommand.fontSize * 0.35)
      const top = textCommand.point.y - ascent - padding
      const bottom = textCommand.point.y + descent + padding

      context.restore()

      if (point.x >= left - padding && point.x <= right + padding && point.y >= top && point.y <= bottom) {
        return { command: textCommand, index }
      }
    }

    return null
  }

  const openTextEditor = (
    command: TextCommand,
    screenPoint: Point,
    _index?: number
  ) => {
    editingTextIdRef.current = command.id

    textCanvasPointRef.current = {
      x: command.point.x,
      y: command.point.y,
    }

    setTextDraft(command.text)
    setTextFont(command.fontFamily)
    setTextSize(command.fontSize)
    setTextBold(command.bold)
    setTextItalic(command.italic)
    setTextUnderline(command.underline)
    setTextAlign(command.align)

    setTextEditor({
      point: screenPoint,
    })
  }
  const editPreviousText = () => {
    for (let index = historyRef.current.length - 1; index >= 0; index -= 1) {
      const command = historyRef.current[index]
      if (isTextCommand(command)) {
        const canvas = canvasRef.current
        const bounds = canvas?.getBoundingClientRect()
        openTextEditor(command, { x: (bounds?.left ?? 0) + command.point.x, y: (bounds?.top ?? 0) + command.point.y }, index)
        return
      }
    }
    setToast({ message: 'Add text to the canvas before editing it', tone: 'info' })
  }

  const drawFill = (context: CanvasRenderingContext2D, command: FillCommand) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const startX = Math.floor(command.point.x * ratio)
    const startY = Math.floor(command.point.y * ratio)
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const target = (startY * image.width + startX) * 4
    const targetColor = image.data.slice(target, target + 4)
    const replacement = hexToRgb(command.color) ?? { r: 0, g: 0, b: 0 }
    if (targetColor[0] === replacement.r && targetColor[1] === replacement.g && targetColor[2] === replacement.b && targetColor[3] === 255) return
    const stack = [[startX, startY]]
    const matches = (index: number) => image.data[index] === targetColor[0] && image.data[index + 1] === targetColor[1] && image.data[index + 2] === targetColor[2] && image.data[index + 3] === targetColor[3]
    while (stack.length) { const [x, y] = stack.pop()!; if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue; const index = (y * image.width + x) * 4; if (!matches(index)) continue; image.data[index] = replacement.r; image.data[index + 1] = replacement.g; image.data[index + 2] = replacement.b; image.data[index + 3] = 255; stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]) }
    context.putImageData(image, 0, 0)
  }

  const redrawHistory = () => {
    const canvas = canvasRef.current
    const context = contextRef.current
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    for (const command of historyRef.current) drawCommand(context, command)
    for (const command of remoteStrokesRef.current) drawCommand(context, command)
    context.globalCompositeOperation = 'source-over'
  }

  const redrawWithShapePreview = (preview: ShapeCommand | null) => {
    redrawHistory()
    if (preview && contextRef.current) drawShape(contextRef.current, preview)
  }

  const commitCommand = (command: CanvasCommand) => {
    historyRef.current.push(command)
    redoRef.current = []
    socketRef.current?.emit('canvas-operation', command as CanvasOperation)
    redrawHistory()
    setHasDrawing(true)
    setCanUndo(true)
    setCanRedo(false)
  }

  const drawRemoteBatch = (batch: DrawingBatch) => {
    const context = contextRef.current
    if (!context || batch.points.length === 0) return
    const existingStroke = remoteStrokeMapRef.current.get(batch.strokeId)
    const stroke = existingStroke ?? { points: [], color: batch.color, size: batch.size, tool: batch.tool, brush: batch.brush }
    const newPoints = existingStroke ? batch.points.slice(1) : batch.points
    stroke.points.push(...newPoints)
    if (!existingStroke) {
      remoteStrokesRef.current.push(stroke)
      remoteStrokeMapRef.current.set(batch.strokeId, stroke)
    }
    drawStroke(context, { ...stroke, points: batch.points })
    setHasDrawing(true)
  }

  const drawRemoteOperation = (operation: CanvasOperation) => {
    if (operation.kind === 'text-update') {
      const index = remoteStrokesRef.current.findIndex((command) => {
        const textCommand = getTextCommand(command)
        return textCommand?.id === operation.id
      })
      if (index >= 0) {
        remoteStrokesRef.current[index] = operation
      } else {
        remoteStrokesRef.current.push(operation)
      }
      redrawHistory()
      return
    }
    remoteStrokesRef.current.push(operation)
    const context = contextRef.current
    if (context) drawCommand(context, operation)
    setHasDrawing(true)
  }

  const transformPoint = (point: Point, action: TransformAction | number, width: number, height: number): Point => {
    if (typeof action === 'number') {
      const radians = (action * Math.PI) / 180
      const centerX = width / 2
      const centerY = height / 2
      const x = point.x - centerX
      const y = point.y - centerY
      return { x: x * Math.cos(radians) - y * Math.sin(radians) + centerX, y: x * Math.sin(radians) + y * Math.cos(radians) + centerY }
    }
    if (action === 'flip-horizontal') return { x: width - point.x, y: point.y }
    if (action === 'flip-vertical') return { x: point.x, y: height - point.y }
    if (action === 'rotate-right') return { x: height - point.y, y: point.x }
    if (action === 'rotate-left') return { x: point.y, y: width - point.x }
    return { x: width - point.x, y: height - point.y }
  }

  const applyTransform = (action: TransformAction | number) => {
    const canvas = canvasRef.current
    if (!canvas || !hasDrawing) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const transformStrokes = (commands: CanvasCommand[]) => commands.forEach((command) => { if ('kind' in command) { if (command.kind === 'shape') { command.start = transformPoint(command.start, action, width, height); command.end = transformPoint(command.end, action, width, height) } else if (command.kind === 'text-update') { command.command.point = transformPoint(command.command.point, action, width, height); if (command.previous) command.previous.point = transformPoint(command.previous.point, action, width, height) } else command.point = transformPoint(command.point, action, width, height) } else command.points = command.points.map((point) => transformPoint(point, action, width, height)) })
    transformStrokes(historyRef.current)
    transformStrokes(remoteStrokesRef.current)
    redoRef.current = []
    redrawHistory()
    setCanUndo(historyRef.current.length > 0)
    setCanRedo(false)
    setToast({ message: typeof action === 'number' ? `Rotated ${action}°` : action.replaceAll('-', ' '), tone: 'success' })
  }

  const applyCustomRotation = () => {
    const angle = Number(customAngle)
    if (!Number.isFinite(angle)) {
      setToast({ message: 'Enter a valid rotation angle', tone: 'error' })
      return
    }
    applyTransform(angle)
    setIsTransformOpen(false)
  }

  const updateRemoteCursor = (cursor: CursorUpdate) => {
    const layer = cursorLayerRef.current
    if (!layer) return
    let element = cursorElementsRef.current.get(cursor.id)
    if (!element) {
      element = document.createElement('div')
      element.className = 'pointer-events-none absolute z-20 flex items-start gap-1 transition-[transform,opacity] duration-75'
      const pointer = document.createElement('span')
      pointer.className = 'mt-0.5 size-3 rotate-45 rounded-[2px] border-2 border-white shadow-sm'
      const label = document.createElement('span')
      label.className = 'rounded px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm'
      element.append(pointer, label)
      layer.append(element)
      cursorElementsRef.current.set(cursor.id, element)
    }
    const pointer = element.firstElementChild as HTMLElement
    const label = element.lastElementChild as HTMLElement
    pointer.style.backgroundColor = cursor.color
    pointer.style.borderColor = cursor.color
    label.style.backgroundColor = cursor.color
    label.textContent = cursor.name
    element.style.left = `${Math.max(0, Math.min(100, cursor.x * 100))}%`
    element.style.top = `${Math.max(0, Math.min(100, cursor.y * 100))}%`
    element.style.opacity = cursor.visible ? '1' : '0'
  }

  const removeMissingCursors = (users: RoomUser[]) => {
    const userIds = new Set(users.map((user) => user.id))
    for (const [userId, element] of cursorElementsRef.current) {
      if (!userIds.has(userId)) {
        element.remove()
        cursorElementsRef.current.delete(userId)
      }
    }
  }

  const sendCursorPosition = (position: CursorPosition) => {
    pendingCursorRef.current = position
    if (cursorTimerRef.current !== null) return
    cursorTimerRef.current = window.setTimeout(() => {
      cursorTimerRef.current = null
      const socket = socketRef.current
      const pendingCursor = pendingCursorRef.current
      if (socket?.connected && pendingCursor) socket.emit('cursor-move', pendingCursor)
      pendingCursorRef.current = null
    }, 50)
  }

  const applyRoomSnapshot = useCallback((snapshot: RoomSnapshot) => {
    roomIdRef.current = snapshot.id
    roomUsersRef.current = snapshot.users
    removeMissingCursors(snapshot.users)
    setRoomId(snapshot.id)
    setRoomUsers(snapshot.users)
    window.history.pushState({}, '', `/room/${encodeURIComponent(snapshot.id)}`)
  }, [])

  const handleRoomUsers = (snapshot: RoomSnapshot) => {
    const previousUsers = roomUsersRef.current
    const joinedUser = snapshot.users.find((user) => !previousUsers.some((previous) => previous.id === user.id))
    const leftUser = previousUsers.find((user) => !snapshot.users.some((current) => current.id === user.id))
    if (joinedUser && previousUsers.length > 0) setRoomNotice(`${joinedUser.name} joined the room`)
    if (leftUser) setRoomNotice(`${leftUser.name} left the room`)
    roomUsersRef.current = snapshot.users
    removeMissingCursors(snapshot.users)
    setRoomUsers(snapshot.users)
  }

  const joinRoom = useCallback((requestedRoomId: string) => {
    const normalisedRoomId = requestedRoomId.trim().toLowerCase()
    if (!normalisedRoomId) {
      setRoomNotice('Enter a room ID first')
      setToast({ message: 'Enter a room ID first', tone: 'error' })
      return
    }
    const socket = socketRef.current
    if (!socket || !socket.connected) {
      setRoomNotice('Waiting for the server connection')
      setToast({ message: 'Waiting for the server connection', tone: 'info' })
      return
    }
    setRoomAction('joining')
    socket.emit('join-room', { roomId: normalisedRoomId, name: userName }, (response) => {
      setRoomAction('idle')
      if (!response.ok) {
        setRoomNotice(response.error)
        setToast({ message: response.error, tone: 'error' })
        return
      }
      applyRoomSnapshot(response.room)
      setJoinInput('')
      setRoomNotice('')
      setToast({ message: `Joined ${response.room.id}`, tone: 'success' })
    })
  }, [applyRoomSnapshot, userName])

  const createRoom = () => {
    const socket = socketRef.current
    if (!socket || !socket.connected) {
      setRoomNotice('Waiting for the server connection')
      setToast({ message: 'Waiting for the server connection', tone: 'info' })
      return
    }
    const newRoomId = `room-${Math.random().toString(36).slice(2, 8)}`
    setRoomAction('creating')
    socket.emit('create-room', { roomId: newRoomId, name: userName }, (response) => {
      setRoomAction('idle')
      if (!response.ok) {
        setRoomNotice(response.error)
        setToast({ message: response.error, tone: 'error' })
        return
      }
      applyRoomSnapshot(response.room)
      setRoomNotice('Room created')
      setToast({ message: `Created ${response.room.id}`, tone: 'success' })
    })
  }

  const leaveRoom = () => {
    const socket = socketRef.current
    const finishLeaving = () => {
      setRoomAction('idle')
      roomIdRef.current = ''
      roomUsersRef.current = []
      setRoomId('')
      setRoomUsers([])
      setRoomNotice('You left the room')
      setToast({ message: 'You left the room', tone: 'info' })
      window.history.pushState({}, '', '/')
    }
    if (!socket?.connected || !roomIdRef.current) {
      finishLeaving()
      return
    }
    setRoomAction('leaving')
    socket.emit('leave-room', () => finishLeaving())
  }

  const copyRoomLink = async () => {
    if (!roomId) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}`)
      setRoomNotice('Room link copied')
      setToast({ message: 'Room link copied to clipboard', tone: 'success' })
    } catch {
      setToast({ message: 'Could not copy the room link', tone: 'error' })
    }
  }

  useEffect(() => {
    joinRoomRef.current = joinRoom
  }, [joinRoom])

  useEffect(() => {
    const socket = io(import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001') as CanvasSocket
    socketRef.current = socket

    socket.on('connect', () => {
      setIsConnected(true)
      if (roomIdRef.current) joinRoomRef.current(roomIdRef.current)
    })
    socket.on('disconnect', () => {
      setIsConnected(false)
      setRoomNotice('Connection lost. Reconnecting...')
      setToast({ message: 'Connection lost. Reconnecting...', tone: 'error' })
      roomUsersRef.current = []
      setRoomUsers([])
    })
    socket.on('room-users', handleRoomUsers)
    socket.on('draw-batch', drawRemoteBatch)
    socket.on('canvas-operation', drawRemoteOperation)
    socket.on('cursor-update', updateRemoteCursor)
    const cursorElements = cursorElementsRef.current

    return () => {
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current)
      if (cursorTimerRef.current !== null) window.clearTimeout(cursorTimerRef.current)
      socket.off('room-users', handleRoomUsers)
      socket.off('draw-batch', drawRemoteBatch)
      socket.off('canvas-operation', drawRemoteOperation)
      socket.off('cursor-update', updateRemoteCursor)
      for (const element of cursorElements.values()) element.remove()
      cursorElements.clear()
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!isColorDialogOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsColorDialogOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isColorDialogOpen])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvasContainerRef.current
    if (!canvas || !container) return

    const resizeCanvas = () => {
      const bounds = canvas.getBoundingClientRect()
      const pixelRatio = window.devicePixelRatio || 1
      const previousCanvas = document.createElement('canvas')
      previousCanvas.width = canvas.width
      previousCanvas.height = canvas.height
      previousCanvas.getContext('2d')?.drawImage(canvas, 0, 0)

      canvas.width = Math.max(1, Math.floor(bounds.width * pixelRatio))
      canvas.height = Math.max(1, Math.floor(bounds.height * pixelRatio))
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      contextRef.current = context
      if (historyRef.current.length > 0) {
        redrawHistory()
      } else if (previousCanvas.width && previousCanvas.height) {
        context.drawImage(previousCanvas, 0, 0, previousCanvas.width / (window.devicePixelRatio || 1), previousCanvas.height / (window.devicePixelRatio || 1), 0, 0, bounds.width, bounds.height)
      }
    }

    resizeCanvas()
    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const bounds = canvas.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const flushDrawingBatch = (complete: boolean) => {
    const socket = socketRef.current
    const pendingPoints = pendingPointsRef.current
    if (!socket || pendingPoints.length === 0) return
    const points = lastSentPointRef.current ? [lastSentPointRef.current, ...pendingPoints] : [...pendingPoints]
    socket.emit('draw-batch', {
      strokeId: strokeIdRef.current,
      points,
      color,
      size: brushSizes[brushSize],
      tool,
      brush: brushType,
      complete,
    })
    lastSentPointRef.current = pendingPoints[pendingPoints.length - 1]
    pendingPointsRef.current = []
    if (sendTimerRef.current !== null) {
      window.clearTimeout(sendTimerRef.current)
      sendTimerRef.current = null
    }
  }

  const scheduleDrawingBatch = () => {
    if (sendTimerRef.current !== null) return
    sendTimerRef.current = window.setTimeout(() => {
      sendTimerRef.current = null
      flushDrawingBatch(false)
    }, 32)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (canvas) {
      const bounds = canvas.getBoundingClientRect()
      sendCursorPosition({
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
        visible: true,
      })
    }
    draw(event)
  }

  const hideCursor = () => {
    sendCursorPosition({ x: 0, y: 0, visible: false })
  }

  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const context = contextRef.current
    if (!context) return
    const point = getCanvasPoint(event)
    if (canvasTool === 'fill') {
      commitCommand({ kind: 'fill', point, color })
      return
    }
    if (canvasTool === 'text') {
      const existing = findTextAtPoint(point)
      if (existing) {
        openTextEditor(existing.command, { x: event.clientX, y: event.clientY }, existing.index)
        textDragRef.current = { id: existing.command.id, index: existing.index, origin: { ...existing.command.point }, offset: { x: point.x - existing.command.point.x, y: point.y - existing.command.point.y }, original: { ...existing.command, point: { ...existing.command.point } }, moved: false }
        isDrawingRef.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
      } else openTextEditor({ kind: 'text', id: crypto.randomUUID(), point, text: '', color, fontFamily: textFont, fontSize: textSize, bold: textBold, italic: textItalic, underline: textUnderline, align: textAlign }, { x: event.clientX, y: event.clientY })
      return
    }
    if (canvasTool === 'shapes') {
      isDrawingRef.current = true
      currentShapeRef.current = { kind: 'shape', shape: shapeType, start: point, end: point, color, size: brushSizes[brushSize], fillColor, fillMode, tool: 'brush' }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    isDrawingRef.current = true
    setHasDrawing(true)
    lastPointRef.current = point
    currentStrokeRef.current = { points: [point], color, size: brushSizes[brushSize], tool, brush: brushType }
    strokeIdRef.current = crypto.randomUUID()
    pendingPointsRef.current = [point]
    lastSentPointRef.current = null
    scheduleDrawingBatch()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawBrushPath(context, [point], currentStrokeRef.current)
  }

  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const context = contextRef.current
    if (!context || !isDrawingRef.current) return
    const point = getCanvasPoint(event)
    if (canvasTool === 'text' && textDragRef.current) {
      const drag = textDragRef.current
      const command = historyRef.current[drag.index]
      const textCommand = getTextCommand(command)
      if (textCommand && textCommand.id === drag.id) {
        const distance = Math.hypot(point.x - (drag.origin.x + drag.offset.x), point.y - (drag.origin.y + drag.offset.y))
        if (distance > 3) drag.moved = true
        const movedCommand = { ...textCommand, point: { x: point.x - drag.offset.x, y: point.y - drag.offset.y } }
        if (isTextUpdateCommand(command)) {
          historyRef.current[drag.index] = { ...command, command: movedCommand }
        } else {
          historyRef.current[drag.index] = movedCommand
        }
        textCanvasPointRef.current = movedCommand.point
        redrawHistory()
      }
      return
    }
    if (canvasTool === 'shapes' && currentShapeRef.current) {
      currentShapeRef.current.end = point
      redrawWithShapePreview(currentShapeRef.current)
      return
    }
    const segment = currentStrokeRef.current ?? { points: [], color, size: brushSizes[brushSize], tool, brush: brushType }
    drawBrushPath(context, [lastPointRef.current, point], segment)
    lastPointRef.current = point
    currentStrokeRef.current?.points.push(point)
    pendingPointsRef.current.push(point)
    scheduleDrawingBatch()
  }

  const stopDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false
    if (canvasTool === 'text' && textDragRef.current) {
      const drag = textDragRef.current
      const command = historyRef.current[drag.index]
      const textCommand = getTextCommand(command)
      if (drag.moved && textCommand) commitTextUpdate(drag.index, drag.original, textCommand)
      textDragRef.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      return
    }
    if (canvasTool === 'shapes' && currentShapeRef.current) {
      commitCommand(currentShapeRef.current)
      currentShapeRef.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      return
    }
    if (currentStrokeRef.current) {
      historyRef.current.push(currentStrokeRef.current)
      redoRef.current = []
      currentStrokeRef.current = null
      setCanUndo(true)
      setCanRedo(false)
    }
    flushDrawingBatch(true)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const commitTextUpdate = (index: number, previous: TextCommand, command: TextCommand) => {
    const update: TextUpdateCommand = { kind: 'text-update', id: command.id, command, previous }
    historyRef.current[index] = update
    redoRef.current = []
    socketRef.current?.emit('canvas-operation', { kind: 'text-update', id: command.id, command })
    redrawHistory()
    setCanUndo(true)
    setCanRedo(false)
  }

  const confirmText = () => {
    if (!textEditor || !textDraft.trim()) return
    const command: TextCommand = {
      kind: 'text',
      id: editingTextIdRef.current ?? crypto.randomUUID(),
      point: textCanvasPointRef.current ?? textEditor.point,
      text: textDraft,
      color,
      fontFamily: textFont,
      fontSize: textSize,
      bold: textBold,
      italic: textItalic,
      underline: textUnderline,
      align: textAlign,
    }
    const editingIndex = editingTextIdRef.current ? historyRef.current.findIndex((item) => {
      const candidate = getTextCommand(item)
      return candidate?.id === editingTextIdRef.current
    }) : -1
    if (editingIndex >= 0) {
      const previous = getTextCommand(historyRef.current[editingIndex])
      if (previous) commitTextUpdate(editingIndex, previous, command)
    } else commitCommand(command)
    setTextEditor(null)
    setTextDraft('')
    editingTextIdRef.current = null
  }

  const undo = () => {
    const command = historyRef.current.pop()
    if (!command) return
    if (isTextUpdateCommand(command) && command.previous) {
      historyRef.current.push(command.previous)
      redoRef.current.push(command)
    } else redoRef.current.push(command)
    redrawHistory()
    setHasDrawing(historyRef.current.length > 0)
    setCanUndo(historyRef.current.length > 0)
    setCanRedo(true)
  }

  const redo = () => {
    const command = redoRef.current.pop()
    if (!command) return
    if (isTextUpdateCommand(command)) {
      historyRef.current.pop()
      historyRef.current.push(command)
    } else historyRef.current.push(command)
    redrawHistory()
    setHasDrawing(true)
    setCanUndo(true)
    setCanRedo(redoRef.current.length > 0)
  }

  const clearCanvas = () => {
    const canvas = canvasRef.current
    const context = contextRef.current
    if (!canvas || !context) return
    historyRef.current = []
    redoRef.current = []
    pendingPointsRef.current = []
    lastSentPointRef.current = null
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    setHasDrawing(false)
    setCanUndo(false)
    setCanRedo(false)
  }

  return (
    <main className="min-h-screen bg-[#f4f1eb] px-4 py-5 text-[#252525] sm:px-7 sm:py-7 lg:px-10">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-[1440px] flex-col overflow-hidden rounded-[2px] border border-[#d9d4ca] bg-[#fbfaf7] shadow-[0_18px_60px_rgba(58,49,38,0.08)] sm:min-h-[calc(100vh-3.5rem)]">
        <header className="flex flex-col gap-5 border-b border-[#e4dfd6] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-full bg-[#1f2825] text-sm font-bold tracking-[-0.04em] text-[#f7f2e9]">CD</div>
            <div><h1 className="font-display text-xl font-semibold tracking-[-0.04em] text-[#1f2825]">CollabDraw</h1><p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[#9b958a]">Shared studio</p></div>
          </div>
          <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end"><span className={`flex items-center gap-2 text-xs font-semibold ${isConnected ? 'text-[#63745f]' : 'text-[#a06c5b]'}`}><span className={`size-2 rounded-full shadow-[0_0_0_4px_#eaf0e4] ${isConnected ? 'bg-[#94a97e]' : 'bg-[#c6b29f]'}`} />{isConnected ? 'Connected' : 'Reconnecting...'}</span><div className="flex flex-wrap gap-2"><button type="button" onClick={createRoom} disabled={!isConnected || roomAction !== 'idle'} className="action-button border-[#d9d4ca] bg-white text-[#5e5a53] hover:border-[#a9a297] hover:bg-[#f7f5f0]" title="Create a new room">{roomAction === 'creating' ? <><span className="spinner" />Creating...</> : 'Create Room'}</button><div className="flex min-w-0 flex-1 overflow-hidden rounded-full border border-[#d9d4ca] bg-white shadow-sm sm:flex-none"><input aria-label="Room ID to join" value={joinInput} onChange={(event) => setJoinInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') joinRoom(joinInput) }} placeholder="Room ID" className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs outline-none placeholder:text-[#b0aaa0] focus:bg-[#fcfbf8] sm:w-24" /><button type="button" onClick={() => joinRoom(joinInput)} disabled={!isConnected || roomAction !== 'idle'} className="border-l border-[#e8e3da] px-3 py-2 text-xs font-semibold text-[#5e5a53] transition hover:bg-[#f7f5f0] disabled:cursor-not-allowed disabled:opacity-40" title="Join room">{roomAction === 'joining' ? <span className="spinner dark" /> : 'Join'}</button></div>{roomId && <><span className="order-first flex items-center rounded-full bg-[#eef3eb] px-3 py-2 font-mono text-[11px] font-semibold text-[#536b53] sm:order-none">{roomId}</span><button type="button" onClick={copyRoomLink} className="action-button border-[#d9d4ca] bg-white text-[#5e5a53] hover:border-[#a9a297] hover:bg-[#f7f5f0]" title="Copy room link">Copy link</button><button type="button" onClick={leaveRoom} disabled={roomAction !== 'idle'} className="action-button border-[#dfcfc8] bg-[#fffaf8] text-[#9b6a5c] hover:bg-[#fbf3ef]" title="Leave current room">{roomAction === 'leaving' ? <><span className="spinner warm" />Leaving...</> : 'Leave'}</button></>}</div><button type="button" className="profile-button" title={`Your profile: ${userName}`}>{userName.slice(-2).toUpperCase()}</button></div></header>
        <section className="flex flex-1 flex-col gap-5 p-4 sm:p-7 lg:flex-row lg:gap-7 lg:p-9">
          <aside className="flex shrink-0 flex-col justify-between gap-5 lg:w-52">
            <div><div className="mb-4 flex items-center justify-between"><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#aaa399]">Tools</p><span className="rounded bg-[#eeebe4] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#aaa399]">BETA</span></div><div className="grid grid-cols-2 gap-2 lg:grid-cols-1"><button type="button" onClick={() => { setTool('brush'); setCanvasTool('brush') }} aria-pressed={canvasTool === 'brush'} className={`${canvasTool === 'brush' ? 'tool-active' : 'tool-inactive'} tool-button`} title="Brush tool"><span className="grid size-7 place-items-center rounded bg-[#dce5d6] text-[#536b53]">B</span>Brush</button><button type="button" onClick={() => { setTool('eraser'); setCanvasTool('eraser') }} aria-pressed={canvasTool === 'eraser'} className={`${canvasTool === 'eraser' ? 'tool-active' : 'tool-inactive'} tool-button`} title="Eraser tool"><span className="grid size-7 place-items-center rounded bg-[#f0eee9] text-[#807970]">E</span>Eraser</button><button type="button" onClick={() => setCanvasTool('fill')} aria-pressed={canvasTool === 'fill'} className={`${canvasTool === 'fill' ? 'tool-active' : 'tool-inactive'} tool-button`} title="Fill tool"><span className="grid size-7 place-items-center rounded bg-[#f0eee9] text-[#807970]">F</span>Fill</button><button type="button" onClick={() => setCanvasTool('text')} aria-pressed={canvasTool === 'text'} className={`${canvasTool === 'text' ? 'tool-active' : 'tool-inactive'} tool-button`} title="Text tool"><span className="grid size-7 place-items-center rounded bg-[#f0eee9] text-[#807970]">T</span>Text</button><label className="tool-button tool-inactive col-span-2 lg:col-span-1"><span className="grid size-7 place-items-center rounded bg-[#f0eee9] text-[#807970]">S</span><span className="flex-1">Shapes</span><select aria-label="Shapes" value={shapeType} onChange={(event) => { setShapeType(event.target.value as ShapeType); setCanvasTool('shapes') }} className="min-w-0 bg-transparent text-xs outline-none"><option value="rectangle">Rectangle</option><option value="line">Line</option><option value="curve">Curve</option><option value="rounded-rectangle">Rounded Rectangle</option><option value="ellipse">Ellipse</option><option value="circle">Circle</option><option value="triangle">Triangle</option><option value="right-triangle">Right Triangle</option><option value="diamond">Diamond</option><option value="pentagon">Pentagon</option><option value="hexagon">Hexagon</option><option value="star">Star</option><option value="arrow">Arrow</option><option value="double-arrow">Double Arrow</option><option value="callout">Callout</option><option value="cloud">Cloud</option><option value="heart">Heart</option><option value="polygon">Polygon</option></select></label></div></div>
            <div className="grid grid-cols-2 gap-2 border-t border-[#e7e2d9] pt-5 lg:grid-cols-1"><button type="button" onClick={undo} disabled={!canUndo} className="utility-button" title="Undo last action"><span className="text-base leading-none">&#8592;</span>Undo</button><button type="button" onClick={redo} disabled={!canRedo} className="utility-button" title="Redo last action">Redo<span className="text-base leading-none">&#8594;</span></button><button type="button" onClick={clearCanvas} disabled={!hasDrawing} className="utility-button clear-button col-span-2 lg:col-span-1" title="Clear canvas">Clear canvas</button></div>
          </aside>

          <div className="flex min-h-[520px] flex-1 flex-col rounded-[3px] border border-[#e3ded5] bg-[#f0ede7] p-3 sm:p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-4 px-1"><div><p className="text-sm font-semibold text-[#4f4a43]">Untitled collaboration</p><p className="mt-0.5 text-xs text-[#aaa399]">Everyone can draw on this canvas</p></div><div className="flex items-center gap-2 text-[11px] font-medium text-[#9d978e]"><span className="size-1.5 rounded-full bg-[#b9b2a8]" />Last saved just now</div></div><div ref={canvasContainerRef} className="canvas-grid relative min-h-[420px] flex-1 overflow-hidden rounded-[2px] border border-[#d8d3ca] bg-[#fffefa] shadow-[0_8px_20px_rgba(78,67,53,0.05)] sm:min-h-[480px]"><canvas ref={canvasRef} className="absolute inset-0 size-full touch-none cursor-crosshair" onPointerDown={startDrawing} onPointerMove={handlePointerMove} onPointerLeave={hideCursor} onPointerUp={stopDrawing} onPointerCancel={stopDrawing} /><div ref={cursorLayerRef} className="pointer-events-none absolute inset-0 overflow-hidden" /><div className={`${hasDrawing ? 'hidden' : 'flex'} pointer-events-none absolute inset-0 items-center justify-center select-none`}><div className="text-center"><div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-dashed border-[#c9c2b7] text-xl text-[#b6afa4]">+</div><p className="text-sm font-medium text-[#9f988e]">Your canvas is ready</p><p className="mt-1 text-xs text-[#c2bcb2]">Select a tool to start drawing</p></div></div><span className="pointer-events-none absolute bottom-4 left-4 rounded bg-[#f6f3ec] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#b0a99f]">Canvas 01</span></div></div>

          <aside className="flex shrink-0 flex-col gap-7 rounded-[3px] border border-[#e3ded5] bg-[#f8f6f1] p-5 lg:w-56"><div><p className="mb-4 text-[11px] font-bold uppercase tracking-[0.18em] text-[#aaa399]">Brush settings</p><label className="mb-2 block text-xs font-semibold text-[#716b62]" htmlFor="brush-type">Brush type</label><select id="brush-type" value={brushType} onChange={(event) => setBrushType(event.target.value as BrushType)} className="mb-4 w-full appearance-none rounded-[3px] border border-[#ded8ce] bg-white px-3 py-2.5 text-sm font-medium text-[#5e5951] outline-none">{Object.entries(brushLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="mb-2 block text-xs font-semibold text-[#716b62]" htmlFor="brush-size">Brush size</label><select id="brush-size" value={brushSize} onChange={(event) => setBrushSize(event.target.value as BrushSize)} className="w-full appearance-none rounded-[3px] border border-[#ded8ce] bg-white px-3 py-2.5 text-sm font-medium text-[#5e5951] outline-none"><option>Small</option><option>Medium</option><option>Large</option></select></div><div><p className="mb-3 text-xs font-semibold text-[#716b62]">Color</p><button type="button" onClick={() => openColorDialog()} aria-label="Edit colours" className="flex w-full items-center gap-3 rounded-[3px] border border-[#ded8ce] bg-white p-2 text-left transition hover:border-[#bcb5aa] hover:bg-[#fcfbf8]"><span className="size-8 rounded border border-[#d8d2c8]" style={{ backgroundColor: color }} /><span><span className="block text-xs font-semibold text-[#5e5951]">Edit colours</span><span className="font-mono text-[11px] text-[#8f887e]">{color.toUpperCase()}</span></span></button><div className="mt-3 grid grid-cols-6 gap-2">{['#252525', '#b45b48', '#d39d45', '#7d9b71', '#6c8790', '#a98eaf'].map((swatch) => <button key={swatch} type="button" onClick={() => openColorDialog(swatch)} aria-label={`Choose ${swatch}`} className={`size-6 rounded-full border-2 border-white shadow-[0_0_0_1px_#d8d2c8] ${color === swatch ? 'ring-2 ring-[#8fa384] ring-offset-1' : ''}`} style={{ backgroundColor: swatch }} />)}</div></div><div className="border-t border-[#e7e2d9] pt-5"><p className="mb-3 text-[11px] font-bold uppercase tracking-[0.15em] text-[#aaa399]">Transform</p><label className="mb-2 block text-xs font-semibold text-[#716b62]" htmlFor="flip-transform">Image transform</label><select id="flip-transform" defaultValue="" disabled={!hasDrawing} onChange={(event) => { if (event.target.value) applyTransform(event.target.value as TransformAction); event.target.value = '' }} className="mb-3 w-full appearance-none rounded-[3px] border border-[#ded8ce] bg-white px-3 py-2.5 text-sm font-medium text-[#5e5951] outline-none"><option value="" disabled>Choose flip</option><option value="flip-vertical">Flip Vertical</option><option value="flip-horizontal">Flip Horizontal</option></select><label className="mb-2 block text-xs font-semibold text-[#716b62]" htmlFor="rotate-transform">Rotate</label><select id="rotate-transform" defaultValue="" disabled={!hasDrawing} onChange={(event) => { if (event.target.value === 'custom') setIsTransformOpen(true); else if (event.target.value) applyTransform(event.target.value as TransformAction); event.target.value = '' }} className="w-full appearance-none rounded-[3px] border border-[#ded8ce] bg-white px-3 py-2.5 text-sm font-medium text-[#5e5951] outline-none"><option value="" disabled>Choose rotation</option><option value="rotate-right">Rotate Right 90°</option><option value="rotate-left">Rotate Left 90°</option><option value="rotate-180">Rotate 180°</option><option value="custom">Rotate Customised</option></select></div><div className="mt-auto border-t border-[#e7e2d9] pt-5"><div className="mb-3 flex items-center justify-between"><p className="text-[11px] font-bold uppercase tracking-[0.15em] text-[#aaa399]">Collaborators</p><span className="text-xs font-semibold text-[#716b62]">{roomUsers.length} connected</span></div>{roomNotice && <p className="mb-3 rounded bg-[#eef3eb] px-2 py-2 text-[11px] font-medium text-[#63745f]">{roomNotice}</p>}<div className="space-y-2">{roomUsers.length === 0 ? <p className="text-xs text-[#aaa399]">Join a room to collaborate</p> : roomUsers.map((user) => <div key={user.id} className="flex items-center gap-2"><span className="size-7 rounded-full" style={{ backgroundColor: user.color }} /><span className="min-w-0 truncate text-xs font-medium text-[#716b62]">{user.name}{user.name === userName && <span className="ml-1 text-[#aaa399]">(you)</span>}</span></div>)}</div></div></aside>
        </section>
      </div>
      <div className="shape-options" aria-label="Shape options"><label>Fill<select aria-label="Fill mode" value={fillMode} onChange={(event) => setFillMode(event.target.value as FillMode)}><option value="none">No Fill</option><option value="solid">Solid Fill</option></select></label><button type="button" onClick={() => openColorDialog(fillColor, 'fill')} title="Choose fill color"><span style={{ backgroundColor: fillColor }} />Fill color</button><button type="button" onClick={editPreviousText} title="Edit previous text">Edit text</button></div>
      {toast && <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite"><span className="toast-dot" />{toast.message}<button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">&#215;</button></div>}
      {textEditor && <div className="text-editor" style={{ left: textEditor.point.x, top: textEditor.point.y }}><textarea aria-label="Text content" autoFocus value={textDraft} onChange={(event) => setTextDraft(event.target.value)} placeholder="Type text" /><div className="text-editor-row"><select aria-label="Text font family" value={textFont} onChange={(event) => setTextFont(event.target.value)}><option>Manrope</option><option>Georgia</option><option>DM Mono</option><option>Arial</option></select><input aria-label="Text font size" type="number" min="8" max="200" value={textSize} onChange={(event) => setTextSize(Number(event.target.value))} /><button type="button" onClick={() => setTextBold((value) => !value)} aria-pressed={textBold}>B</button><button type="button" onClick={() => setTextItalic((value) => !value)} aria-pressed={textItalic}>I</button><button type="button" onClick={() => setTextUnderline((value) => !value)} aria-pressed={textUnderline}>U</button><select aria-label="Text alignment" value={textAlign} onChange={(event) => setTextAlign(event.target.value as CanvasTextAlign)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select><button type="button" onClick={() => setTextEditor(null)} className="text-editor-cancel">Cancel</button><button type="button" onClick={confirmText} className="text-editor-ok">Add</button></div></div>}
      {isTransformOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-[#252525]/25 p-4" role="dialog" aria-modal="true" aria-labelledby="custom-rotation-title"><div className="w-full max-w-xs rounded border border-[#ded8ce] bg-[#fffefa] p-5 shadow-[0_18px_50px_rgba(58,49,38,0.2)]"><h2 id="custom-rotation-title" className="font-display text-sm font-semibold text-[#252525]">Rotate customised</h2><label className="mt-4 block text-xs font-semibold text-[#716b62]" htmlFor="custom-angle">Angle in degrees</label><input id="custom-angle" type="number" value={customAngle} onChange={(event) => setCustomAngle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyCustomRotation() }} className="mt-2 w-full rounded border border-[#ded8ce] bg-white px-3 py-2 text-sm outline-none" autoFocus /><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setIsTransformOpen(false)} className="utility-button">Cancel</button><button type="button" onClick={applyCustomRotation} className="action-button border-[#9fb497] bg-[#eaf1e7] text-[#4e624f]">Rotate</button></div></div></div>}
      {isColorDialogOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-[#252525]/30 p-4" role="dialog" aria-modal="true" aria-labelledby="edit-colours-title" onKeyDown={(event) => { if (event.key === 'Escape') setIsColorDialogOpen(false) }}><div className="paint-dialog w-full max-w-[560px] rounded border border-[#cfcac2] bg-[#f7f6f3] p-5 shadow-[0_20px_60px_rgba(30,28,24,0.25)]"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8f8b84]">Color editor</p><h2 id="edit-colours-title" className="mt-1 text-lg font-semibold tracking-[-0.03em] text-[#2f2e2b]">Edit Colours</h2></div><button type="button" onClick={() => setIsColorDialogOpen(false)} className="grid size-8 place-items-center rounded border border-transparent text-lg text-[#77736c] transition hover:border-[#d6d1c8] hover:bg-white" aria-label="Close color editor">&#215;</button></div><div className="mt-5 grid gap-5 sm:grid-cols-[1fr_170px]"><div><div className="color-spectrum relative h-48 cursor-crosshair overflow-hidden rounded border border-[#c9c4bb]" style={{ backgroundColor: `hsl(${draftHue}, 100%, 50%)` }} onPointerDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const update = (clientX: number, clientY: number) => updateDraftFromHsv(draftHue, ((clientX - rect.left) / rect.width) * 100, 100 - ((clientY - rect.top) / rect.height) * 100); update(event.clientX, event.clientY); const move = (moveEvent: PointerEvent) => update(moveEvent.clientX, moveEvent.clientY); const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop) }}><span className="color-crosshair" style={{ left: `${rgbToHsv(draftRgb).saturation}%`, top: `${100 - (draftBrightness)}%` }} /></div><label className="mt-4 block text-xs font-semibold text-[#5e5951]" htmlFor="brightness-slider">Brightness</label><input id="brightness-slider" type="range" min="0" max="100" value={draftBrightness} onChange={(event) => { const value = Number(event.target.value); updateDraftFromHsv(draftHue, rgbToHsv(draftRgb).saturation, value) }} className="brightness-slider mt-2 w-full" style={{ '--brightness-color': `hsl(${draftHue}, 100%, 50%)` } as React.CSSProperties} aria-label="Brightness slider" /><div className="mt-2 flex justify-between text-[10px] text-[#9d988f]"><span>Black</span><span>Bright</span></div><div className="mt-5"><p className="mb-2 text-xs font-semibold text-[#5e5951]">Basic colors</p><div className="grid grid-cols-10 gap-1.5">{['#000000', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4', '#ffffff', '#c3c3c3', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7'].map((swatch) => <button key={swatch} type="button" className="aspect-square rounded border border-[#c7c2b9] transition hover:scale-110 hover:border-[#4f4b45]" style={{ backgroundColor: swatch }} onClick={() => updateDraftColor(swatch)} aria-label={`Choose basic color ${swatch}`} />)}</div></div></div><div><div className="rounded border border-[#d6d1c8] bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#9b968e]">New color</p><div className="mt-3 h-16 rounded border border-[#d8d2c8]" style={{ backgroundColor: draftColor }} /><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[11px] font-semibold text-[#716b62]">HEX<input aria-label="HEX color" value={draftColor} onChange={(event) => updateDraftColor(event.target.value)} className="mt-1 w-full rounded border border-[#d8d2c8] px-2 py-1.5 font-mono text-xs uppercase outline-none" maxLength={7} /></label><span /></div><p className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#9b968e]">RGB</p><div className="grid grid-cols-3 gap-2">{(['r', 'g', 'b'] as const).map((channel) => <label key={channel} className="text-[11px] font-semibold uppercase text-[#716b62]">{channel}<input aria-label={`RGB ${channel}`} type="number" min="0" max="255" value={draftRgb[channel]} onChange={(event) => { const next = { ...draftRgb, [channel]: clampColorChannel(Number(event.target.value)) }; updateDraftColor(rgbToHex(next.r, next.g, next.b)) }} className="mt-1 w-full rounded border border-[#d8d2c8] px-2 py-1.5 text-xs outline-none" /></label>)}</div></div><div className="mt-4"><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#9b968e]">Custom colors</p><div className="grid grid-cols-5 gap-2">{Array.from({ length: 10 }, (_, index) => <button key={index} type="button" className="aspect-square rounded border border-[#cbc6bd] bg-[#eeece7]" style={{ backgroundColor: customColors[index] || undefined }} onClick={() => customColors[index] && updateDraftColor(customColors[index])} aria-label={customColors[index] ? `Choose custom color ${customColors[index]}` : 'Empty custom color slot'} />)}</div><button type="button" onClick={() => setCustomColors((colors) => colors.includes(draftColor) ? colors : [...colors, draftColor].slice(-10))} className="mt-3 w-full rounded border border-[#d0cbc2] bg-white px-3 py-2 text-xs font-semibold text-[#5e5951] transition hover:border-[#aaa49b] hover:bg-[#f7f5f0]">Add to custom colors</button></div></div></div><div className="mt-5 flex flex-col-reverse gap-2 border-t border-[#ded9d0] pt-4 sm:flex-row sm:justify-end"><button type="button" onClick={() => setIsColorDialogOpen(false)} className="utility-button">Cancel</button><button type="button" onClick={confirmColor} className="action-button border-[#789672] bg-[#789672] text-white hover:bg-[#657f60]">OK</button></div></div></div>}
    </main>
  )
}

export default App
