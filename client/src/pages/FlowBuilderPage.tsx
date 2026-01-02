/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Save,
  Play,
  MessageSquare,
  HelpCircle,
  GitBranch,
  Calendar,
  FileText,
  Webhook,
  Phone,
  Clock,
  StopCircle,
  Plus,
  ArrowLeft,
  X,
  Trash2,
  Info,
  Volume2,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useRoute, useLocation } from "wouter";
import { TestFlowDialog } from "@/components/TestFlowDialog";

// Flow node data interface
interface FlowNodeConfig {
  type?: string;
  message?: string;
  waitForResponse?: boolean;
  question?: string;
  variableName?: string;
  condition?: string;
  trueBranch?: string;
  falseBranch?: string;
  phoneNumber?: string;
  duration?: number;
  webhookUrl?: string;
  formId?: string;
  appointmentType?: string;
  endMessage?: string;
  // Play Audio node config
  audioUrl?: string;
  audioFileName?: string;
  interruptible?: boolean;
  waitForComplete?: boolean;
}

interface FlowNodeData extends Record<string, unknown> {
  type: string;
  label: string;
  config?: FlowNodeConfig;
}

type FlowNode = Node<FlowNodeData>;
type FlowEdge = Edge;

// Icon mapping
const nodeTypeIcons = {
  message: MessageSquare,
  question: HelpCircle,
  condition: GitBranch,
  appointment: Calendar,
  form: FileText,
  webhook: Webhook,
  transfer: Phone,
  delay: Clock,
  end: StopCircle,
  play_audio: Volume2,
};

// Colorful theme for each node type
const nodeTypeColors = {
  message: {
    bg: "from-blue-500 to-blue-600 dark:from-blue-600 dark:to-blue-700",
    icon: "text-white",
    text: "text-white",
    handle: "#3b82f6",
  },
  question: {
    bg: "from-purple-500 to-purple-600 dark:from-purple-600 dark:to-purple-700",
    icon: "text-white",
    text: "text-white",
    handle: "#a855f7",
  },
  condition: {
    bg: "from-amber-500 to-amber-600 dark:from-amber-600 dark:to-amber-700",
    icon: "text-white",
    text: "text-white",
    handle: "#f59e0b",
  },
  appointment: {
    bg: "from-emerald-500 to-emerald-600 dark:from-emerald-600 dark:to-emerald-700",
    icon: "text-white",
    text: "text-white",
    handle: "#10b981",
  },
  form: {
    bg: "from-cyan-500 to-cyan-600 dark:from-cyan-600 dark:to-cyan-700",
    icon: "text-white",
    text: "text-white",
    handle: "#06b6d4",
  },
  webhook: {
    bg: "from-violet-500 to-violet-600 dark:from-violet-600 dark:to-violet-700",
    icon: "text-white",
    text: "text-white",
    handle: "#8b5cf6",
  },
  transfer: {
    bg: "from-pink-500 to-pink-600 dark:from-pink-600 dark:to-pink-700",
    icon: "text-white",
    text: "text-white",
    handle: "#ec4899",
  },
  delay: {
    bg: "from-orange-500 to-orange-600 dark:from-orange-600 dark:to-orange-700",
    icon: "text-white",
    text: "text-white",
    handle: "#f97316",
  },
  end: {
    bg: "from-red-500 to-red-600 dark:from-red-600 dark:to-red-700",
    icon: "text-white",
    text: "text-white",
    handle: "#ef4444",
  },
  play_audio: {
    bg: "from-cyan-500 to-teal-500 dark:from-cyan-600 dark:to-teal-600",
    icon: "text-white",
    text: "text-white",
    handle: "#06b6d4",
  },
};

// Custom node component with connection handles
function FlowNode({ data, selected }: { data: any; selected?: boolean }) {
  const Icon = nodeTypeIcons[data.type as keyof typeof nodeTypeIcons] || MessageSquare;
  const colors = nodeTypeColors[data.type as keyof typeof nodeTypeColors] || nodeTypeColors.message;
  const hasMultipleOutputs = data.type === "condition";
  
  return (
    <div className="relative">
      {/* Input Handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: colors.handle }}
        className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
      />
      
      <div className={`bg-gradient-to-br ${colors.bg} rounded-lg p-3 min-w-[220px] shadow-lg ${selected ? 'ring-2 ring-white dark:ring-gray-300 ring-offset-2 ring-offset-background' : ''} transition-all hover:shadow-xl`}>
        <div className="flex items-center gap-2.5">
          <Icon className={`w-5 h-5 ${colors.icon} flex-shrink-0`} />
          <div className="flex-1 min-w-0">
            <div className={`font-semibold text-sm ${colors.text}`}>{data.label}</div>
            {data.config?.message && (
              <div className="text-xs text-white/80 mt-1 truncate">
                {data.config.message.substring(0, 50)}...
              </div>
            )}
            {data.config?.question && (
              <div className="text-xs text-white/80 mt-1 truncate">
                {data.config.question.substring(0, 50)}...
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Output Handle (bottom) - single or multiple */}
      {hasMultipleOutputs ? (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            style={{ left: '30%', background: '#22c55e' }}
            className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            style={{ left: '70%', background: '#ef4444' }}
            className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: colors.handle }}
          className="!w-3 !h-3 !border-2 !border-white dark:!border-gray-900"
        />
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  message: FlowNode,
  question: FlowNode,
  condition: FlowNode,
  appointment: FlowNode,
  form: FlowNode,
  webhook: FlowNode,
  transfer: FlowNode,
  delay: FlowNode,
  end: FlowNode,
  play_audio: FlowNode,
  custom: FlowNode,
};

export default function FlowBuilderPage() {
  const { t } = useTranslation();
  const [, params] = useRoute("/app/flows/:id");
  const [, setLocation] = useLocation();
  const flowId = params?.id;
  
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [flowName, setFlowName] = useState(t("flows.flowNamePlaceholder"));
  const [flowDescription, setFlowDescription] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Available node types for the sidebar (using translations)
  const availableNodeTypes = [
    { type: "message", label: t("flows.nodeTypes.message"), description: t("flows.nodeDescriptions.message"), icon: MessageSquare },
    { type: "question", label: t("flows.nodeTypes.question"), description: t("flows.nodeDescriptions.question"), icon: HelpCircle },
    { type: "condition", label: t("flows.nodeTypes.condition"), description: t("flows.nodeDescriptions.condition"), icon: GitBranch },
    { type: "appointment", label: t("flows.nodeTypes.appointment"), description: t("flows.nodeDescriptions.appointment"), icon: Calendar },
    { type: "form", label: t("flows.nodeTypes.form"), description: t("flows.nodeDescriptions.form"), icon: FileText },
    { type: "webhook", label: t("flows.nodeTypes.webhook"), description: t("flows.nodeDescriptions.webhook"), icon: Webhook },
    { type: "transfer", label: t("flows.nodeTypes.transfer"), description: t("flows.nodeDescriptions.transfer"), icon: Phone },
    { type: "delay", label: t("flows.nodeTypes.delay"), description: t("flows.nodeDescriptions.delay"), icon: Clock },
    { type: "play_audio", label: t("flows.nodeTypes.playAudio"), description: t("flows.nodeDescriptions.playAudio"), icon: Volume2 },
    { type: "end", label: t("flows.nodeTypes.end"), description: t("flows.nodeDescriptions.end"), icon: StopCircle },
  ];
  
  // Fetch agents for selection
  const { data: agents, isError: agentsError } = useQuery<any[]>({
    queryKey: ["/api/agents"],
  });

  // Check if selected agent uses ElevenLabs engine (doesn't support audio playback)
  const selectedAgent = agents?.find((a: any) => a.id === agentId);
  const isElevenLabsEngine = selectedAgent?.telephonyProvider === 'twilio' || 
                             selectedAgent?.telephonyProvider === 'elevenlabs-sip' ||
                             !selectedAgent?.telephonyProvider; // Default is twilio (ElevenLabs)

  // Fetch forms for form node selection
  const { data: availableForms, isLoading: isLoadingForms, isError: formsError } = useQuery<Array<{
    id: string;
    name: string;
    description: string | null;
    fields?: Array<{
      id: string;
      question: string;
      fieldType: string;
      isRequired: boolean;
      order: number;
    }>;
  }>>({
    queryKey: ["/api/flow-automation/forms"],
  });

  // Load existing flow if editing (not for new flows)
  const { data: flow, isError: flowError, isLoading: flowLoading } = useQuery<any>({
    queryKey: [`/api/flow-automation/flows/${flowId}`],
    enabled: !!flowId && flowId !== "new",
  });

  // Load flow data when fetched
  useEffect(() => {
    if (flow) {
      // Normalize nodes to ensure root-level type matches data.type (matching template format)
      const normalizedNodes = ((flow.nodes as FlowNode[]) || []).map((node) => ({
        ...node,
        type: node.data?.type || node.type, // Ensure type matches data.type
      }));
      setNodes(normalizedNodes);
      setEdges((flow.edges as FlowEdge[]) || []);
      setFlowName(flow.name);
      setFlowDescription(flow.description || "");
      setAgentId(flow.agentId || "");
    }
  }, [flow, setNodes, setEdges]);

  // Handle connection creation with validation
  const onConnect = useCallback(
    (connection: Connection) => {
      // Prevent self-connections
      if (connection.source === connection.target) {
        toast({
          title: t("flows.toast.invalidConnection"),
          description: t("flows.toast.cannotConnectSelf"),
          variant: "destructive",
        });
        return;
      }
      
      // Add edge with ID immediately (required for state management)
      const edgeWithId = {
        ...connection,
        id: `edge-${connection.source}-${connection.target}${connection.sourceHandle ? `-${connection.sourceHandle}` : ''}`,
        animated: true,
      };
      
      // @ts-expect-error - xyflow's addEdge has overly strict animated type requirement
      setEdges((eds) => addEdge(edgeWithId, eds));
    },
    [setEdges, toast, t]
  );

  // Handle node click (single click to select)
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node as FlowNode);
  }, []);

  // Save flow mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Ensure all edges have IDs (required by backend schema)
      const edgesWithIds = edges.map((edge) => ({
        ...edge,
        id: edge.id || `edge-${edge.source}-${edge.target}`,
      }));

      // Ensure nodes have correct format matching templates
      // Root-level type should match data.type (e.g., "message", "question")
      const nodesWithCorrectFormat = nodes.map((node) => ({
        ...node,
        type: node.data.type, // Use actual node type, not "custom"
      }));

      const flowData = {
        name: flowName,
        description: flowDescription,
        nodes: nodesWithCorrectFormat,
        edges: edgesWithIds,
        agentId: agentId || null,
        isActive: flow?.isActive ?? true,
      };

      const isNewFlow = !flowId || flowId === "new";
      const response = isNewFlow 
        ? await apiRequest("POST", "/api/flow-automation/flows", flowData)
        : await apiRequest("PATCH", `/api/flow-automation/flows/${flowId}`, flowData);
      
      // Parse and return the JSON response so onSuccess gets the flow data with id
      const data = await response.json();
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: t("flows.toast.saved"),
        description: t("flows.toast.savedDescription"),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/flow-automation/flows"] });
      
      const isNewFlow = !flowId || flowId === "new";
      
      // Invalidate the individual flow query to refresh the editor with latest data
      if (!isNewFlow) {
        queryClient.invalidateQueries({ queryKey: [`/api/flow-automation/flows/${flowId}`] });
      }
      
      // Navigate to edit mode if this was a new flow
      if (isNewFlow && data?.id) {
        setLocation(`/app/flows/${data.id}`);
      }
    },
    onError: (error: any) => {
      toast({
        title: t("flows.toast.saveError"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Add new node to canvas
  const addNode = (type: string) => {
    const nodeLabel = availableNodeTypes.find((n) => n.type === type)?.label || type;
    const newNode: FlowNode = {
      id: `node-${Date.now()}`,
      type: type, // Use actual node type to match template format (e.g., "message", "question")
      position: { x: 250, y: 50 + nodes.length * 100 },
      data: {
        type,
        label: nodeLabel,
        config: {
          type,
        },
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedNode(newNode);
  };

  // Update selected node configuration
  const updateNodeConfig = (config: any) => {
    if (!selectedNode) return;
    
    setNodes((nds) =>
      nds.map((node) =>
        node.id === selectedNode.id
          ? { ...node, data: { ...node.data, config: { ...node.data.config, ...config } } }
          : node
      )
    );
    
    // Update selected node state
    setSelectedNode((prev) =>
      prev ? { ...prev, data: { ...prev.data, config: { ...prev.data.config, ...config } } } : null
    );
  };

  // Delete selected node
  const deleteNode = () => {
    if (!selectedNode) return;
    
    setNodes((nds) => nds.filter((node) => node.id !== selectedNode.id));
    setEdges((eds) => eds.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedNode(null);
  };

  // Get available nodes for dropdowns
  const getAvailableNodes = () => {
    return nodes.map((node) => ({
      id: node.id,
      label: `${node.data.label} (${node.id.substring(node.id.length - 8)})`,
    }));
  };

  return (
    <div className="flex h-screen w-full">
      {/* Sidebar - Node Types with Teal Theme */}
      <div className="w-60 flex-shrink-0 flex flex-col border-r bg-gradient-to-b from-teal-50/50 via-cyan-50/30 to-background dark:from-teal-950/30 dark:via-cyan-950/20 dark:to-background">
        {/* Sidebar Header */}
        <div className="p-4 border-b border-teal-100 dark:border-teal-900/50">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/app/flows")}
            className="mb-3 -ml-2"
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("flows.backToFlows")}
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-teal-500/25">
              <GitBranch className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-teal-900 dark:text-teal-100" data-testid="text-node-types-title">{t("flows.title")}</h3>
              <p className="text-xs text-teal-600/70 dark:text-teal-400/70">
                {t("flows.subtitle")}
              </p>
            </div>
          </div>
        </div>

        {/* Node Types */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-xs font-medium text-teal-700 dark:text-teal-300 mb-3 uppercase tracking-wider">
            {t("flows.addNodes")}
          </div>
          <div className="space-y-2">
            {availableNodeTypes.map((nodeType) => {
              const Icon = nodeType.icon;
              const colors = nodeTypeColors[nodeType.type as keyof typeof nodeTypeColors];
              return (
                <Button
                  key={nodeType.type}
                  variant="outline"
                  className="w-full justify-start gap-2 h-auto py-2.5 hover-elevate active-elevate-2 border-l-4 bg-white/50 dark:bg-white/5"
                  style={{ borderLeftColor: colors.handle }}
                  onClick={() => addNode(nodeType.type)}
                  data-testid={`button-add-${nodeType.type}-node`}
                >
                  <div 
                    className={`p-1.5 rounded bg-gradient-to-br ${colors.bg}`}
                  >
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="font-medium text-sm">{nodeType.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {nodeType.description}
                    </div>
                  </div>
                  <Plus className="w-4 h-4 flex-shrink-0 text-teal-500" />
                </Button>
              );
            })}
          </div>
        </div>

        {/* Sidebar Footer Tip */}
        <div className="p-4 border-t border-teal-100 dark:border-teal-900/50 bg-teal-50/50 dark:bg-teal-950/30">
          <p className="text-xs text-teal-600 dark:text-teal-400">
            {t("flows.tipClickNodes")}
          </p>
        </div>
      </div>

      {/* Main Canvas */}
      <div className="flex-1 flex flex-col">
        {/* Top Toolbar with Teal Theme */}
        <div className="border-b px-4 py-3 flex items-center justify-between gap-4 bg-gradient-to-r from-teal-50/80 via-cyan-50/50 to-background dark:from-teal-950/40 dark:via-cyan-950/30 dark:to-background">
          <div className="flex-1">
            <input
              type="text"
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              className="text-lg font-semibold bg-transparent border-none outline-none w-full"
              placeholder={t("flows.flowName")}
              data-testid="input-flow-name"
            />
            <input
              type="text"
              value={flowDescription}
              onChange={(e) => setFlowDescription(e.target.value)}
              className="text-sm text-muted-foreground bg-transparent border-none outline-none w-full mt-1"
              placeholder={t("flows.flowDescriptionPlaceholder")}
              data-testid="input-flow-description"
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Agent Selection */}
            <div className="min-w-[200px]">
              <Label className="text-xs text-muted-foreground mb-1">{t("flows.voiceAgent")}</Label>
              <Select value={agentId || "none"} onValueChange={(val) => setAgentId(val === "none" ? "" : val)}>
                <SelectTrigger className="h-8 text-sm" data-testid="select-agent">
                  <SelectValue placeholder={t("flows.selectAgent")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("flows.noAgent")}</SelectItem>
                  {agents?.filter((agent: any) => agent.type === 'flow').map((agent: any) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="button-help">
                    <Info className="w-4 h-4 mr-2" />
                    {t("flows.help")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-96" align="end">
                  <div className="space-y-4">
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.howToBuild")}</h4>
                      <p className="text-xs text-muted-foreground">
                        {t("flows.helpContent.howToBuildDesc")}
                      </p>
                    </div>
                    
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.questionVariables")}</h4>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("flows.helpContent.questionVariablesDesc")}
                      </p>
                      <div className="bg-muted/50 p-2 rounded text-xs font-mono">
                        Question: "Can I transfer your call?"<br/>
                        Variable: transfer_consent
                      </div>
                    </div>
                    
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.usingConditions")}</h4>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t("flows.helpContent.usingConditionsDesc")}
                      </p>
                      <div className="bg-muted/50 p-2 rounded text-xs font-mono space-y-1">
                        <div>transfer_consent == "yes"</div>
                        <div>age &gt; 18</div>
                        <div>response contains "help"</div>
                      </div>
                    </div>
                    
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("flows.helpContent.callTransferExample")}</h4>
                      <p className="text-xs text-muted-foreground">
                        {t("flows.helpContent.callTransferExampleDesc")}
                      </p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </TooltipProvider>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!flowId) {
                  toast({
                    title: t("flows.toast.saveFirst"),
                    description: t("flows.toast.saveFirstDescription"),
                    variant: "destructive",
                  });
                  return;
                }
                setTestDialogOpen(true);
              }}
              disabled={!flowId}
              className="border-teal-200 dark:border-teal-800 hover:bg-teal-50 dark:hover:bg-teal-950/50"
              data-testid="button-test-flow"
            >
              <Play className="w-4 h-4 mr-2 text-teal-600 dark:text-teal-400" />
              {t("flows.test")}
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-600 hover:to-cyan-700 text-white shadow-md shadow-teal-500/25"
              data-testid="button-save-flow"
            >
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? t("flows.saving") : t("flows.save")}
            </Button>
          </div>
        </div>

        {/* React Flow Canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            snapToGrid
            snapGrid={[15, 15]}
            defaultEdgeOptions={{ 
              animated: true, 
              style: { 
                strokeWidth: 2.5,
                stroke: 'url(#edge-gradient)',
              } 
            }}
            data-testid="flow-canvas"
          >
            <svg width="0" height="0">
              <defs>
                <linearGradient id="edge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#14b8a6" />
                  <stop offset="50%" stopColor="#06b6d4" />
                  <stop offset="100%" stopColor="#0891b2" />
                </linearGradient>
              </defs>
            </svg>
            <Background 
              variant={BackgroundVariant.Dots} 
              gap={20} 
              size={1.5} 
              className="bg-gradient-to-br from-teal-50/30 via-cyan-50/30 to-white dark:from-teal-950/20 dark:via-cyan-950/20 dark:to-background" 
            />
            <Controls className="!bg-background/90 !backdrop-blur !border !border-border !shadow-lg" />
            <MiniMap 
              className="!bg-background/90 !backdrop-blur !border !border-border !shadow-lg" 
              nodeColor={(node) => {
                const type = node.data?.type as keyof typeof nodeTypeColors;
                const colors = nodeTypeColors[type];
                if (colors) {
                  return colors.handle;
                }
                return "hsl(var(--primary))";
              }}
              maskColor="rgba(0, 0, 0, 0.1)"
            />
          </ReactFlow>

          {/* Properties Panel (Right Sidebar) with Teal Theme */}
          {selectedNode && (
            <div className="absolute right-0 top-0 bottom-0 w-72 bg-gradient-to-b from-teal-50/30 via-background to-background dark:from-teal-950/20 dark:via-background border-l shadow-lg overflow-y-auto z-10">
              <div className="p-4 border-b border-teal-100 dark:border-teal-900/50 flex items-center justify-between sticky top-0 bg-gradient-to-r from-teal-50/80 to-cyan-50/50 dark:from-teal-950/50 dark:to-cyan-950/30 backdrop-blur z-10">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = nodeTypeIcons[selectedNode.data.type as keyof typeof nodeTypeIcons] || MessageSquare;
                    return <Icon className="w-4 h-4 text-teal-600 dark:text-teal-400" />;
                  })()}
                  <h3 className="font-semibold text-sm text-teal-900 dark:text-teal-100">{t("flows.nodeProperties")}</h3>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={deleteNode}
                    data-testid="button-delete-node"
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setSelectedNode(null)}
                    data-testid="button-close-properties"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="p-4 space-y-4">
                {/* Node ID (read-only reference) */}
                <div>
                  <Label className="text-xs text-muted-foreground">{t("flows.nodeId")}</Label>
                  <div className="text-sm font-mono bg-muted/50 px-2 py-1.5 rounded mt-1 break-all">
                    {selectedNode.id}
                  </div>
                </div>

                {/* Message Node */}
                {selectedNode.data.type === "message" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="message">{t("flows.nodeConfig.message")}</Label>
                      <Textarea
                        id="message"
                        value={selectedNode.data.config?.message || ""}
                        onChange={(e) => updateNodeConfig({ message: e.target.value })}
                        placeholder={t("flows.nodeConfig.messagePlaceholder")}
                        className="mt-1"
                        data-testid="input-message"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponse"
                        checked={selectedNode.data.config?.waitForResponse ?? false}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponse" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Question Node */}
                {selectedNode.data.type === "question" && (
                  <>
                    <div>
                      <Label htmlFor="question">{t("flows.nodeConfig.question")}</Label>
                      <Textarea
                        id="question"
                        value={selectedNode.data.config?.question || ""}
                        onChange={(e) => updateNodeConfig({ question: e.target.value })}
                        placeholder={t("flows.nodeConfig.questionPlaceholder")}
                        className="mt-1"
                        data-testid="input-question"
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Label htmlFor="variableName">{t("flows.nodeConfig.variableName")}</Label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="text-xs">
                                {t("flows.nodeConfig.variableTooltip")}
                              </p>
                              <div className="mt-2 p-2 bg-muted rounded text-xs font-mono">
                                {t("flows.nodeConfig.variableExample")}<br/>
                                Variable: transfer_consent<br/>
                                Use in condition: transfer_consent == "yes"
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Input
                        id="variableName"
                        value={selectedNode.data.config?.variableName || ""}
                        onChange={(e) => updateNodeConfig({ variableName: e.target.value })}
                        placeholder={t("flows.nodeConfig.variableNamePlaceholder")}
                        className="mt-1"
                        data-testid="input-variable-name"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.variableNameHint")}
                      </p>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseQuestion"
                        checked={selectedNode.data.config?.waitForResponse ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseQuestion" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </>
                )}

                {/* Condition Node with Smart Node Selector */}
                {selectedNode.data.type === "condition" && (
                  <>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Label htmlFor="condition">{t("flows.nodeConfig.condition")}</Label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="text-xs mb-2">
                                {t("flows.nodeConfig.conditionTooltip")}
                              </p>
                              <div className="space-y-1 text-xs font-mono bg-muted p-2 rounded">
                                <div>transfer_consent == "yes"</div>
                                <div>age &gt; 18</div>
                                <div>response contains "help"</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Textarea
                        id="condition"
                        value={selectedNode.data.config?.condition || ""}
                        onChange={(e) => updateNodeConfig({ condition: e.target.value })}
                        placeholder={t("flows.nodeConfig.conditionPlaceholder")}
                        className="mt-1"
                        data-testid="input-condition"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.conditionHint")}
                      </p>
                    </div>
                    
                    {/* True Branch - Node Selector */}
                    <div>
                      <Label htmlFor="trueBranch">{t("flows.nodeConfig.trueBranch")}</Label>
                      <Select
                        value={selectedNode.data.config?.trueBranch || ""}
                        onValueChange={(value) => updateNodeConfig({ trueBranch: value })}
                      >
                        <SelectTrigger className="mt-1" data-testid="select-true-branch">
                          <SelectValue placeholder={t("flows.nodeConfig.selectNextNode")} />
                        </SelectTrigger>
                        <SelectContent>
                          {getAvailableNodes()
                            .filter((n) => n.id !== selectedNode.id)
                            .map((node) => (
                              <SelectItem key={node.id} value={node.id}>
                                {node.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* False Branch - Node Selector */}
                    <div>
                      <Label htmlFor="falseBranch">{t("flows.nodeConfig.falseBranch")}</Label>
                      <Select
                        value={selectedNode.data.config?.falseBranch || ""}
                        onValueChange={(value) => updateNodeConfig({ falseBranch: value })}
                      >
                        <SelectTrigger className="mt-1" data-testid="select-false-branch">
                          <SelectValue placeholder={t("flows.nodeConfig.selectNextNode")} />
                        </SelectTrigger>
                        <SelectContent>
                          {getAvailableNodes()
                            .filter((n) => n.id !== selectedNode.id)
                            .map((node) => (
                              <SelectItem key={node.id} value={node.id}>
                                {node.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {/* Transfer Node */}
                {selectedNode.data.type === "transfer" && (
                  <div>
                    <Label htmlFor="phoneNumber">{t("flows.nodeConfig.phoneNumber")}</Label>
                    <Input
                      id="phoneNumber"
                      value={selectedNode.data.config?.phoneNumber || ""}
                      onChange={(e) => updateNodeConfig({ phoneNumber: e.target.value })}
                      placeholder={t("flows.nodeConfig.phoneNumberPlaceholder")}
                      className="mt-1"
                      data-testid="input-phone-number"
                    />
                  </div>
                )}

                {/* Delay Node */}
                {selectedNode.data.type === "delay" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="duration">{t("flows.nodeConfig.duration")}</Label>
                      <Input
                        id="duration"
                        type="number"
                        value={selectedNode.data.config?.duration || 1}
                        onChange={(e) => updateNodeConfig({ duration: parseInt(e.target.value) })}
                        placeholder={t("flows.nodeConfig.durationPlaceholder")}
                        min="1"
                        className="mt-1"
                        data-testid="input-duration"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseDelay"
                        checked={selectedNode.data.config?.waitForResponse ?? false}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseDelay" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Play Audio Node */}
                {selectedNode.data.type === "play_audio" && (
                  <div className="space-y-4">
                    {/* Warning for ElevenLabs engines that don't support audio playback */}
                    {isElevenLabsEngine && agentId && (
                      <Alert variant="destructive" className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800">
                        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        <AlertTitle className="text-amber-800 dark:text-amber-200">{t("flows.nodeConfig.playAudioWarningTitle")}</AlertTitle>
                        <AlertDescription className="text-amber-700 dark:text-amber-300 text-xs">
                          {t("flows.nodeConfig.playAudioWarningElevenLabs")}
                        </AlertDescription>
                      </Alert>
                    )}
                    <div>
                      <Label>{t("flows.nodeConfig.audioFile")}</Label>
                      {selectedNode.data.config?.audioUrl ? (
                        <div className="mt-2 p-3 bg-muted/50 rounded-lg border">
                          <div className="flex items-center gap-2">
                            <Volume2 className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm font-medium truncate flex-1">
                              {selectedNode.data.config?.audioFileName || "Audio file"}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 flex-shrink-0"
                              onClick={() => updateNodeConfig({ audioUrl: "", audioFileName: "" })}
                              data-testid="button-remove-audio"
                            >
                              <X className="w-4 h-4 text-destructive" />
                            </Button>
                          </div>
                          <audio 
                            controls 
                            src={selectedNode.data.config?.audioUrl} 
                            className="w-full mt-2 h-8"
                            data-testid="audio-preview"
                          />
                        </div>
                      ) : (
                        <div className="mt-2">
                          <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed rounded-lg cursor-pointer bg-muted/30 hover:bg-muted/50 border-cyan-300 dark:border-cyan-700">
                            <div className="flex flex-col items-center justify-center pt-2 pb-2">
                              <Upload className="w-6 h-6 mb-1 text-cyan-600" />
                              <p className="text-xs text-muted-foreground">{t("flows.nodeConfig.uploadAudio")}</p>
                              <p className="text-xs text-muted-foreground/70">MP3, WAV (max 5MB)</p>
                            </div>
                            <input 
                              type="file" 
                              className="hidden" 
                              accept=".mp3,.wav,audio/mpeg,audio/wav"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                if (file.size > 5 * 1024 * 1024) {
                                  toast({ title: t("flows.nodeConfig.fileTooLarge"), variant: "destructive" });
                                  return;
                                }
                                const formData = new FormData();
                                formData.append("audio", file);
                                try {
                                  const token = localStorage.getItem("auth_token");
                                  const res = await fetch("/api/audio/upload", { 
                                    method: "POST", 
                                    body: formData,
                                    headers: token ? { Authorization: `Bearer ${token}` } : {}
                                  });
                                  if (!res.ok) throw new Error("Upload failed");
                                  const data = await res.json();
                                  updateNodeConfig({ audioUrl: data.url, audioFileName: file.name });
                                  toast({ title: t("flows.nodeConfig.audioUploaded") });
                                } catch (err) {
                                  toast({ title: t("flows.nodeConfig.uploadFailed"), variant: "destructive" });
                                }
                              }}
                              data-testid="input-audio-upload"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="interruptible"
                        checked={selectedNode.data.config?.interruptible ?? false}
                        onCheckedChange={(checked) => updateNodeConfig({ interruptible: !!checked })}
                        data-testid="checkbox-interruptible"
                      />
                      <Label htmlFor="interruptible" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.interruptible")}
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForComplete"
                        checked={selectedNode.data.config?.waitForComplete ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForComplete: !!checked })}
                        data-testid="checkbox-wait-for-complete"
                      />
                      <Label htmlFor="waitForComplete" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForComplete")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Webhook Node */}
                {selectedNode.data.type === "webhook" && (
                  <div>
                    <Label htmlFor="webhookUrl">{t("flows.nodeConfig.webhookUrl")}</Label>
                    <Input
                      id="webhookUrl"
                      value={selectedNode.data.config?.webhookUrl || ""}
                      onChange={(e) => updateNodeConfig({ webhookUrl: e.target.value })}
                      placeholder={t("flows.nodeConfig.webhookUrlPlaceholder")}
                      className="mt-1"
                      data-testid="input-webhook-url"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("flows.nodeConfig.webhookHint")}
                    </p>
                  </div>
                )}

                {/* Form Node */}
                {selectedNode.data.type === "form" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="formId">{t("flows.nodeConfig.selectForm")}</Label>
                      <Select
                        value={selectedNode.data.config?.formId || ""}
                        onValueChange={(value) => {
                          const selectedForm = availableForms?.find(f => f.id === value);
                          updateNodeConfig({ 
                            formId: value,
                            formName: selectedForm?.name || ""
                          });
                        }}
                      >
                        <SelectTrigger className="mt-1" data-testid="select-form">
                          <SelectValue placeholder={t("flows.nodeConfig.selectFormPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableForms?.map((form) => (
                            <SelectItem key={form.id} value={form.id}>
                              {form.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {(!availableForms || availableForms.length === 0) && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          {t("flows.nodeConfig.noFormsAvailable")}
                        </p>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="formIntroMessage">{t("flows.nodeConfig.introMessage")}</Label>
                      <Textarea
                        id="formIntroMessage"
                        value={selectedNode.data.config?.message || ""}
                        onChange={(e) => updateNodeConfig({ message: e.target.value })}
                        placeholder={t("flows.nodeConfig.formIntroPlaceholder")}
                        className="mt-1"
                        rows={2}
                        data-testid="input-form-intro"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.formIntroHint")}
                      </p>
                    </div>

                    {selectedNode.data.config?.formId && (() => {
                      const selectedForm = availableForms?.find(f => f.id === selectedNode.data.config?.formId);
                      const formFields = selectedForm?.fields;
                      
                      return (
                        <div className="p-3 bg-muted/50 rounded-md">
                          <p className="text-xs font-medium text-muted-foreground mb-2">
                            {t("flows.nodeConfig.formFieldsPreview")}
                          </p>
                          {isLoadingForms || !availableForms ? (
                            <p className="text-xs text-muted-foreground italic">
                              {t("flows.nodeConfig.loadingFields")}
                            </p>
                          ) : !selectedForm ? (
                            <p className="text-xs text-amber-600 dark:text-amber-400">
                              {t("flows.nodeConfig.formNotFound")}
                            </p>
                          ) : formFields && formFields.length > 0 ? (
                            <ul className="text-xs space-y-1">
                              {formFields
                                .sort((a, b) => a.order - b.order)
                                .map((field, idx) => (
                                  <li key={field.id} className="flex items-center gap-2">
                                    <span className="text-muted-foreground">{idx + 1}.</span>
                                    <span>{field.question}</span>
                                    {field.isRequired && (
                                      <span className="text-amber-600 dark:text-amber-400">*</span>
                                    )}
                                  </li>
                                ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">
                              {t("flows.nodeConfig.noFieldsDefined")}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseForm"
                        checked={selectedNode.data.config?.waitForResponse ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseForm" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* Appointment Node */}
                {selectedNode.data.type === "appointment" && (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="appointmentType">{t("flows.nodeConfig.appointmentType")}</Label>
                      <Input
                        id="appointmentType"
                        value={selectedNode.data.config?.appointmentType || ""}
                        onChange={(e) => updateNodeConfig({ appointmentType: e.target.value })}
                        placeholder={t("flows.nodeConfig.appointmentTypePlaceholder")}
                        className="mt-1"
                        data-testid="input-appointment-type"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("flows.nodeConfig.appointmentHint")}
                      </p>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="waitForResponseAppointment"
                        checked={selectedNode.data.config?.waitForResponse ?? true}
                        onCheckedChange={(checked) => updateNodeConfig({ waitForResponse: !!checked })}
                        data-testid="checkbox-wait-for-response"
                      />
                      <Label htmlFor="waitForResponseAppointment" className="text-sm font-normal cursor-pointer">
                        {t("flows.nodeConfig.waitForResponse")}
                      </Label>
                    </div>
                  </div>
                )}

                {/* End Node */}
                {selectedNode.data.type === "end" && (
                  <div>
                    <Label htmlFor="endMessage">{t("flows.nodeConfig.endMessage")}</Label>
                    <Textarea
                      id="endMessage"
                      value={selectedNode.data.config?.endMessage || ""}
                      onChange={(e) => updateNodeConfig({ endMessage: e.target.value })}
                      placeholder={t("flows.nodeConfig.endMessagePlaceholder")}
                      className="mt-1"
                      data-testid="input-end-message"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Test Flow Dialog */}
      {flowId && (
        <TestFlowDialog
          open={testDialogOpen}
          onOpenChange={setTestDialogOpen}
          flowId={flowId}
          flowName={flowName}
        />
      )}
    </div>
  );
}
