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
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Phone, CheckCircle2, XCircle, PhoneCall, PhoneIncoming } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { PhoneConflictDialog, PhoneConflictState, initialPhoneConflictState } from "./PhoneConflictDialog";

interface TestFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  flowName: string;
}

// Helper function to get status label and progress
const getCallProgress = (status: string): { label: string; progress: number; description: string; isComplete: boolean; isError: boolean } => {
  const statusMap: Record<string, { label: string; progress: number; description: string; isComplete: boolean; isError: boolean }> = {
    "initiated": { label: "Call Initiated", progress: 20, description: "Connecting to phone network...", isComplete: false, isError: false },
    "queued": { label: "Call Queued", progress: 30, description: "Waiting for carrier...", isComplete: false, isError: false },
    "ringing": { label: "Ringing", progress: 50, description: "Your phone should be ringing now", isComplete: false, isError: false },
    "in-progress": { label: "Call In Progress", progress: 70, description: "Call connected - testing flow...", isComplete: false, isError: false },
    "answered": { label: "Call Answered", progress: 70, description: "Call connected - testing flow...", isComplete: false, isError: false },
    "completed": { label: "Call Completed", progress: 100, description: "Test call finished successfully", isComplete: true, isError: false },
    "failed": { label: "Call Failed", progress: 100, description: "The call could not be completed", isComplete: true, isError: true },
    "busy": { label: "Line Busy", progress: 100, description: "The phone number was busy", isComplete: true, isError: true },
    "no-answer": { label: "No Answer", progress: 100, description: "No one answered the call", isComplete: true, isError: true },
    "canceled": { label: "Call Canceled", progress: 100, description: "The call was canceled", isComplete: true, isError: true },
  };
  
  return statusMap[status] || { label: "Unknown", progress: 0, description: "Status unknown", isComplete: false, isError: true };
};

export function TestFlowDialog({ open, onOpenChange, flowId, flowName }: TestFlowDialogProps) {
  const { toast } = useToast();
  const [phoneNumber, setPhoneNumber] = useState("");
  const [testCallId, setTestCallId] = useState<string | null>(null);
  const [conflictDialog, setConflictDialog] = useState<PhoneConflictState>(initialPhoneConflictState);

  // Poll for call status
  const { data: callStatus } = useQuery<{ status: string }>({
    queryKey: ["/api/calls", testCallId],
    enabled: !!testCallId,
    refetchInterval: (query) => {
      const status = (query.state.data as { status?: string })?.status;
      // Stop polling if call is complete or failed
      if (!status || ["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
        return false;
      }
      // Poll every 2 seconds while call is in progress
      return 2000;
    },
  });

  // Test call mutation
  const testMutation = useMutation({
    mutationFn: async () => {
      if (!phoneNumber) {
        throw new Error("Phone number is required");
      }

      // Format phone number: preserve leading +, remove other non-digits
      const hasPlus = phoneNumber.trim().startsWith("+");
      const digitsOnly = phoneNumber.replace(/\D/g, "");
      
      if (digitsOnly.length < 10) {
        throw new Error("Please enter a valid phone number (at least 10 digits)");
      }

      // E.164 format: ensure leading +
      const formattedPhone = hasPlus ? `+${digitsOnly}` : `+${digitsOnly}`;

      return apiRequest("POST", `/api/flow-automation/flows/${flowId}/test`, {
        phoneNumber: formattedPhone,
      });
    },
    onSuccess: (data: any) => {
      setTestCallId(data.callId);
      
      // Check if this is infrastructure-ready but not fully implemented
      const isPartialImplementation = data.note || data.message?.includes("coming soon");
      
      // Check if there's a warning about active campaign
      if (data.warning) {
        toast({
          title: "Warning: Phone Number in Use",
          description: data.warning.message,
          variant: "destructive",
          duration: 8000, // Show warning longer
        });
      }
      
      toast({
        title: isPartialImplementation ? "Test Call Record Created" : "Test call initiated",
        description: isPartialImplementation
          ? "Call record created successfully. The flow builder infrastructure is ready. Full call execution requires flow-to-agent integration."
          : "Your test call has been started. Check the Calls page to see the results.",
        variant: isPartialImplementation ? "default" : "default",
      });
    },
    onError: (error: any) => {
      // Check for phone conflict (409)
      if (error.status === 409 || error.conflictType) {
        setConflictDialog({
          isOpen: true,
          title: error.error || "Phone Number Conflict",
          message: error.message || error.error || "This phone number has a conflict.",
          conflictType: error.conflictType,
          connectedAgentName: error.connectedAgentName,
          campaignName: error.campaignName,
        });
        return;
      }
      
      // Handle specific error cases
      const isNoPhoneNumbers = error.message?.includes("No active phone numbers");
      const isNotImplemented = error.message?.includes("not yet implemented") || error.message?.includes("501");
      
      toast({
        title: isNoPhoneNumbers ? "No Phone Numbers" : isNotImplemented ? "Feature Coming Soon" : "Error starting test call",
        description: isNoPhoneNumbers
          ? "You need to purchase or rent a phone number before making test calls. Visit the Phone Numbers page to get started."
          : isNotImplemented 
            ? "Test call functionality is currently under development. The flow builder and management features are ready to use."
            : error.message,
        variant: "destructive",
      });
    },
  });

  const handleClose = () => {
    setPhoneNumber("");
    setTestCallId(null);
    onOpenChange(false);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-test-flow">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-primary" />
            Test Flow: {flowName}
          </DialogTitle>
          <DialogDescription>
            Place a real test call to validate your conversation flow works as expected
          </DialogDescription>
        </DialogHeader>

        {!testCallId ? (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="test-phone">Phone Number *</Label>
              <Input
                id="test-phone"
                type="tel"
                placeholder="+1234567890"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={testMutation.isPending}
                data-testid="input-test-phone"
              />
              <p className="text-xs text-muted-foreground">
                Include country code (e.g., +1 for USA)
              </p>
            </div>

            <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm">
              <div className="font-medium">What happens when you test?</div>
              <ul className="space-y-1 text-muted-foreground list-disc list-inside">
                <li>A real call will be placed to your phone number</li>
                <li>The AI agent will execute your flow nodes in sequence</li>
                <li>The call will be recorded and logged</li>
                <li>You'll see the results in the Calls page</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            {(() => {
              const status = callStatus?.status || "initiated";
              const progress = getCallProgress(status);
              
              return (
                <div className="space-y-6">
                  {/* Status Icon */}
                  <div className="flex flex-col items-center justify-center py-4 space-y-4">
                    {progress.isError ? (
                      <div className="rounded-full bg-red-100 dark:bg-red-900/20 p-4">
                        <XCircle className="w-12 h-12 text-red-600 dark:text-red-500" />
                      </div>
                    ) : progress.isComplete ? (
                      <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-4">
                        <CheckCircle2 className="w-12 h-12 text-green-600 dark:text-green-500" />
                      </div>
                    ) : (
                      <div className="rounded-full bg-blue-100 dark:bg-blue-900/20 p-4 relative">
                        {status === "ringing" ? (
                          <PhoneIncoming className="w-12 h-12 text-blue-600 dark:text-blue-500 animate-pulse" />
                        ) : (
                          <PhoneCall className="w-12 h-12 text-blue-600 dark:text-blue-500" />
                        )}
                        {!progress.isComplete && (
                          <div className="absolute -bottom-1 -right-1">
                            <Loader2 className="w-6 h-6 text-blue-600 dark:text-blue-500 animate-spin" />
                          </div>
                        )}
                      </div>
                    )}
                    
                    {/* Status Text */}
                    <div className="text-center space-y-2">
                      <div className="font-semibold text-lg">{progress.label}</div>
                      <div className="text-sm text-muted-foreground">
                        {progress.description}
                      </div>
                      <div className="text-xs font-mono bg-muted/50 px-3 py-1.5 rounded">
                        Call ID: {testCallId.substring(0, 12)}...
                      </div>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Progress</span>
                      <span>{progress.progress}%</span>
                    </div>
                    <Progress value={progress.progress} className="h-2" data-testid="progress-call-status" />
                  </div>

                  {/* Additional Info */}
                  {!progress.isComplete && (
                    <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm">
                      <div className="font-medium">What to expect:</div>
                      <ul className="space-y-1 text-muted-foreground list-disc list-inside">
                        {status === "initiated" || status === "queued" ? (
                          <>
                            <li>The call is being connected</li>
                            <li>Your phone will ring in a moment</li>
                          </>
                        ) : status === "ringing" ? (
                          <>
                            <li>Your phone should be ringing now</li>
                            <li>Answer to start the flow test</li>
                          </>
                        ) : (
                          <>
                            <li>The AI is executing your flow</li>
                            <li>Listen and respond to test it</li>
                          </>
                        )}
                      </ul>
                    </div>
                  )}

                  {progress.isComplete && (
                    <div className={`rounded-lg p-4 space-y-2 text-sm ${
                      progress.isError 
                        ? "bg-red-100 dark:bg-red-900/20 text-red-900 dark:text-red-100"
                        : "bg-green-100 dark:bg-green-900/20 text-green-900 dark:text-green-100"
                    }`}>
                      <div className="font-medium">
                        {progress.isError ? "Call Failed" : "Test Complete"}
                      </div>
                      <ul className="space-y-1 list-disc list-inside opacity-90">
                        {progress.isError ? (
                          <>
                            <li>Check that the phone number is correct</li>
                            <li>Ensure you have sufficient credits</li>
                            <li>Try calling again in a moment</li>
                          </>
                        ) : (
                          <>
                            <li>Check the Calls page for the transcript</li>
                            <li>Review flow execution in Execution Logs</li>
                            <li>Adjust your flow based on the results</li>
                          </>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        <DialogFooter className="gap-2">
          {!testCallId ? (
            <>
              <Button variant="outline" onClick={handleClose} data-testid="button-cancel-test">
                Cancel
              </Button>
              <Button
                onClick={() => testMutation.mutate()}
                disabled={!phoneNumber || testMutation.isPending}
                data-testid="button-start-test"
              >
                {testMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Starting Call...
                  </>
                ) : (
                  <>
                    <Phone className="w-4 h-4 mr-2" />
                    Start Test Call
                  </>
                )}
              </Button>
            </>
          ) : (
            <Button onClick={handleClose} className="w-full" data-testid="button-close-success">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <PhoneConflictDialog
      open={conflictDialog.isOpen}
      onClose={() => setConflictDialog(initialPhoneConflictState)}
      title={conflictDialog.title}
      message={conflictDialog.message}
      conflictType={conflictDialog.conflictType}
      connectedAgentName={conflictDialog.connectedAgentName}
      campaignName={conflictDialog.campaignName}
    />
    </>
  );
}
