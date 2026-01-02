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
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Calendar as CalendarIcon, Clock, Settings, ChevronLeft, ChevronRight, AlertCircle, CalendarDays, CalendarCheck, User } from "lucide-react";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, startOfWeek, endOfWeek } from "date-fns";

interface AppointmentMetadata {
  aiCollectedPhone?: string;
  verifiedPhone?: string;
  phoneDiscrepancy?: boolean;
  aiCollectedName?: string;
  verifiedName?: string;
}

interface Appointment {
  id: string;
  userId: string;
  callId: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  scheduledFor: string;
  duration: number;
  serviceName: string | null;
  status: string;
  notes: string | null;
  metadata: AppointmentMetadata | null;
  createdAt: string;
}

interface AppointmentSettings {
  id: string;
  userId: string;
  allowOverlap: boolean;
  bufferTime: number;
  maxPerDay: number | null;
  workingHoursStart: string;
  workingHoursEnd: string;
  workingDays: string[];
  createdAt: string;
  updatedAt: string;
}

const defaultSettings: Partial<AppointmentSettings> = {
  allowOverlap: false,
  bufferTime: 15,
  maxPerDay: null,
  workingHoursStart: "09:00",
  workingHoursEnd: "17:00",
  workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
};

export default function AppointmentsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [view, setView] = useState<"day" | "week" | "month">("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsData, setSettingsData] = useState<Partial<AppointmentSettings>>(defaultSettings);

  const { data: appointments = [], isLoading } = useQuery<Appointment[]>({
    queryKey: ["/api/flow-automation/appointments"],
  });

  const { data: settings } = useQuery<AppointmentSettings>({
    queryKey: ["/api/flow-automation/appointment-settings"],
  });

  useEffect(() => {
    if (settings) {
      setSettingsData(settings);
    }
  }, [settings]);

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        allowOverlap: settingsData.allowOverlap ?? false,
        bufferTime: settingsData.bufferTime ?? 15,
        maxPerDay: settingsData.maxPerDay ?? null,
        workingHoursStart: settingsData.workingHoursStart || "09:00",
        workingHoursEnd: settingsData.workingHoursEnd || "17:00",
        workingDays: settingsData.workingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
      };
      
      const res = await apiRequest("PUT", "/api/flow-automation/appointment-settings", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/flow-automation/appointment-settings"] });
      toast({ title: t("appointments.toast.settingsSaved") });
      setSettingsOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: t("appointments.toast.settingsFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getAppointmentsForDate = (date: Date) => {
    return appointments.filter((apt) => isSameDay(new Date(apt.scheduledFor), date));
  };

  const getMonthDays = () => {
    const start = startOfWeek(startOfMonth(currentDate));
    const end = endOfWeek(endOfMonth(currentDate));
    return eachDayOfInterval({ start, end });
  };

  const handlePrevious = () => {
    setCurrentDate(subMonths(currentDate, 1));
  };

  const handleNext = () => {
    setCurrentDate(addMonths(currentDate, 1));
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  };

  const toggleWorkingDay = (day: string) => {
    const workingDays = settingsData.workingDays || [];
    if (workingDays.includes(day)) {
      setSettingsData({ ...settingsData, workingDays: workingDays.filter((d) => d !== day) });
    } else {
      setSettingsData({ ...settingsData, workingDays: [...workingDays, day] });
    }
  };

  const calendarDays = [
    { key: "sun", label: t("appointments.calendar.days.sun") },
    { key: "mon", label: t("appointments.calendar.days.mon") },
    { key: "tue", label: t("appointments.calendar.days.tue") },
    { key: "wed", label: t("appointments.calendar.days.wed") },
    { key: "thu", label: t("appointments.calendar.days.thu") },
    { key: "fri", label: t("appointments.calendar.days.fri") },
    { key: "sat", label: t("appointments.calendar.days.sat") },
  ];

  const workingDayOptions = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-muted-foreground">{t("appointments.loading")}</div>
        </div>
      </div>
    );
  }

  const totalAppointments = appointments.length;
  const upcomingAppointments = appointments.filter(apt => new Date(apt.scheduledFor) > new Date()).length;
  const completedAppointments = appointments.filter(apt => apt.status === 'completed').length;
  const cancelledAppointments = appointments.filter(apt => apt.status === 'cancelled').length;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-rose-50 via-pink-100/50 to-red-50 dark:from-rose-950/40 dark:via-pink-900/30 dark:to-red-950/40 border border-rose-100 dark:border-rose-900/50 p-6 md:p-8">
        <div className="absolute inset-0 bg-grid-slate-200/50 dark:bg-grid-slate-700/20 [mask-image:linear-gradient(0deg,transparent,rgba(255,255,255,0.5))]" />
        <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center shadow-lg shadow-rose-500/25">
              <CalendarDays className="h-7 w-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-foreground" data-testid="text-page-title">
                {t("appointments.title")}
              </h1>
              <p className="text-muted-foreground mt-0.5">{t("appointments.subtitle")}</p>
            </div>
          </div>
          <Button 
            onClick={() => setSettingsOpen(true)} 
            variant="outline" 
            className="border-rose-200 dark:border-rose-800"
            data-testid="button-settings"
          >
            <Settings className="h-4 w-4 mr-2" />
            {t("common.settings")}
          </Button>
        </div>

        <div className="relative mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="bg-white/80 dark:bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-rose-100/50 dark:border-rose-800/30">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-rose-600 dark:text-rose-400" />
              <div className="text-2xl font-bold text-rose-700 dark:text-rose-300">{totalAppointments}</div>
            </div>
            <div className="text-rose-600/70 dark:text-rose-400/70 text-sm">{t("appointments.stats.total")}</div>
          </div>
          <div className="bg-white/80 dark:bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-pink-100/50 dark:border-pink-800/30">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-pink-600 dark:text-pink-400" />
              <div className="text-2xl font-bold text-pink-700 dark:text-pink-300">{upcomingAppointments}</div>
            </div>
            <div className="text-pink-600/70 dark:text-pink-400/70 text-sm">{t("appointments.stats.upcoming")}</div>
          </div>
          <div className="bg-white/80 dark:bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-emerald-100/50 dark:border-emerald-800/30">
            <div className="flex items-center gap-2">
              <CalendarCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{completedAppointments}</div>
            </div>
            <div className="text-emerald-600/70 dark:text-emerald-400/70 text-sm">{t("appointments.stats.completed")}</div>
          </div>
          <div className="bg-white/80 dark:bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-slate-100/50 dark:border-slate-700/30">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              <div className="text-2xl font-bold text-slate-700 dark:text-slate-300">{cancelledAppointments}</div>
            </div>
            <div className="text-slate-600/70 dark:text-slate-400/70 text-sm">{t("appointments.stats.cancelled")}</div>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={handlePrevious} data-testid="button-prev-month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={handleToday} data-testid="button-today">
                {t("appointments.calendar.today")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleNext} data-testid="button-next-month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <h2 className="text-xl font-semibold" data-testid="text-current-month">
              {format(currentDate, "MMMM yyyy")}
            </h2>
            <Tabs value={view} onValueChange={(v: any) => setView(v)}>
              <TabsList>
                <TabsTrigger value="day" data-testid="tab-day">{t("appointments.calendar.day")}</TabsTrigger>
                <TabsTrigger value="week" data-testid="tab-week">{t("appointments.calendar.week")}</TabsTrigger>
                <TabsTrigger value="month" data-testid="tab-month">{t("appointments.calendar.month")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {view === "month" && (
            <div>
              <div className="grid grid-cols-7 gap-2 mb-2">
                {calendarDays.map((day) => (
                  <div key={day.key} className="text-center text-sm font-semibold text-muted-foreground py-2">
                    {day.label}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-2">
                {getMonthDays().map((day, index) => {
                  const dayAppointments = getAppointmentsForDate(day);
                  const isCurrentMonth = isSameMonth(day, currentDate);
                  const isToday = isSameDay(day, new Date());

                  return (
                    <div
                      key={index}
                      className={`min-h-24 p-2 border rounded-md ${
                        !isCurrentMonth ? "bg-muted/30 text-muted-foreground" : ""
                      } ${isToday ? "border-primary bg-primary/5" : ""} hover-elevate`}
                      data-testid={`calendar-day-${format(day, "yyyy-MM-dd")}`}
                    >
                      <div className="text-sm font-medium mb-1">{format(day, "d")}</div>
                      {dayAppointments.length > 0 && (
                        <div className="space-y-1">
                          {dayAppointments.slice(0, 2).map((apt) => (
                            <div
                              key={apt.id}
                              className="text-xs p-1 bg-primary/10 border border-primary/20 rounded truncate"
                              title={`${apt.contactName} - ${format(new Date(apt.scheduledFor), "h:mm a")}`}
                              data-testid={`appointment-${apt.id}`}
                            >
                              <Clock className="h-3 w-3 inline mr-1" />
                              {format(new Date(apt.scheduledFor), "h:mm a")}
                            </div>
                          ))}
                          {dayAppointments.length > 2 && (
                            <div className="text-xs text-muted-foreground">
                              {t("appointments.calendar.more", { count: dayAppointments.length - 2 })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {view === "week" && (
            <div className="text-center py-12 text-muted-foreground">
              {t("appointments.calendar.weekViewSoon")}
            </div>
          )}

          {view === "day" && (
            <div className="text-center py-12 text-muted-foreground">
              {t("appointments.calendar.dayViewSoon")}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("appointments.upcomingAppointments")}</CardTitle>
          <CardDescription>{t("appointments.upcomingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            // Filter for upcoming appointments (scheduled >= now) and sort by soonest first
            const now = new Date();
            const upcomingAppointments = appointments
              .filter((apt) => new Date(apt.scheduledFor) >= now)
              .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
            
            if (upcomingAppointments.length === 0) {
              return (
                <div className="flex flex-col items-center justify-center py-12">
                  <CalendarIcon className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t("appointments.noAppointments")}</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-md">
                    {t("appointments.noAppointmentsDescription")}
                  </p>
                </div>
              );
            }
            
            return (
              <ScrollArea className="h-96">
                <div className="space-y-3 pr-4">
                  {upcomingAppointments.map((apt) => (
                    <Card key={apt.id} className="hover-elevate">
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <User className="h-4 w-4 text-muted-foreground" />
                              <div className="font-semibold" data-testid={`text-contact-name-${apt.id}`}>
                                {apt.contactName}
                              </div>
                              <Badge variant={apt.status === "confirmed" ? "default" : "secondary"}>
                                {apt.status}
                              </Badge>
                              {apt.metadata?.phoneDiscrepancy && (
                                <Badge variant="outline" className="text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-700">
                                  <AlertCircle className="h-3 w-3 mr-1" />
                                  Phone mismatch
                                </Badge>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground space-y-0.5">
                              <div className="flex items-center gap-1">
                                <span className="font-medium text-foreground">{apt.contactPhone}</span>
                                {apt.contactEmail && <span>• {apt.contactEmail}</span>}
                              </div>
                              {apt.metadata?.phoneDiscrepancy && apt.metadata.aiCollectedPhone && (
                                <div className="text-xs text-amber-600 dark:text-amber-400">
                                  AI heard: {apt.metadata.aiCollectedPhone}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-medium" data-testid={`text-scheduled-time-${apt.id}`}>
                              {format(new Date(apt.scheduledFor), "MMM d, yyyy")}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {format(new Date(apt.scheduledFor), "h:mm a")}
                            </div>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          {apt.serviceName && (
                            <div>
                              <span className="text-muted-foreground">{t("appointments.details.service")}: </span>
                              <span className="font-medium">{apt.serviceName}</span>
                            </div>
                          )}
                          <div>
                            <span className="text-muted-foreground">{t("appointments.duration")}: </span>
                            <span className="font-medium">{t("appointments.durationMinutes", { count: apt.duration })}</span>
                          </div>
                        </div>
                        {apt.notes && (
                          <div className="mt-3 p-2 bg-muted/50 rounded-md text-sm">
                            <span className="text-muted-foreground">{t("appointments.details.notes")}: </span>
                            {apt.notes}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </ScrollArea>
            );
          })()}
        </CardContent>
      </Card>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle data-testid="text-settings-title">{t("appointments.settings.title")}</DialogTitle>
            <DialogDescription>{t("appointments.settings.description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>{t("appointments.settings.allowOverlap")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("appointments.settings.allowOverlapDescription")}
                  </p>
                </div>
                <Switch
                  checked={settingsData.allowOverlap}
                  onCheckedChange={(checked) => setSettingsData({ ...settingsData, allowOverlap: checked })}
                  data-testid="switch-allow-overlap"
                />
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="buffer-time">{t("appointments.settings.bufferTime")}</Label>
                <Input
                  id="buffer-time"
                  type="number"
                  value={settingsData.bufferTime}
                  onChange={(e) => setSettingsData({ ...settingsData, bufferTime: parseInt(e.target.value) || 0 })}
                  data-testid="input-buffer-time"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="max-per-day">{t("appointments.settings.maxPerDay")}</Label>
                <Input
                  id="max-per-day"
                  type="number"
                  placeholder={t("appointments.settings.maxPerDayPlaceholder")}
                  value={settingsData.maxPerDay || ""}
                  onChange={(e) =>
                    setSettingsData({ ...settingsData, maxPerDay: e.target.value ? parseInt(e.target.value) : null })
                  }
                  data-testid="input-max-per-day"
                />
              </div>

              <Separator />

              <div className="space-y-3">
                <Label>{t("appointments.settings.workingHours")}</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="hours-start">{t("appointments.settings.startTime")}</Label>
                    <Input
                      id="hours-start"
                      type="time"
                      value={settingsData.workingHoursStart}
                      onChange={(e) => setSettingsData({ ...settingsData, workingHoursStart: e.target.value })}
                      data-testid="input-hours-start"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hours-end">{t("appointments.settings.endTime")}</Label>
                    <Input
                      id="hours-end"
                      type="time"
                      value={settingsData.workingHoursEnd}
                      onChange={(e) => setSettingsData({ ...settingsData, workingHoursEnd: e.target.value })}
                      data-testid="input-hours-end"
                    />
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <Label>{t("appointments.settings.workingDays")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  {workingDayOptions.map((day) => (
                    <div
                      key={day}
                      className={`p-3 border rounded-md cursor-pointer hover-elevate ${
                        settingsData.workingDays?.includes(day) ? "border-primary bg-primary/5" : ""
                      }`}
                      onClick={() => toggleWorkingDay(day)}
                      data-testid={`day-option-${day}`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`h-4 w-4 rounded border ${
                            settingsData.workingDays?.includes(day)
                              ? "bg-primary border-primary"
                              : "border-muted-foreground"
                          }`}
                        />
                        <span className="text-sm font-medium capitalize">{t(`appointments.settings.days.${day}`)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)} data-testid="button-cancel-settings">
              {t("common.cancel")}
            </Button>
            <Button onClick={() => saveSettingsMutation.mutate()} disabled={saveSettingsMutation.isPending} data-testid="button-save-settings">
              {t("appointments.settings.saveSettings")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
