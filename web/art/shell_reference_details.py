# Reference face: x=24..1021, y=6..667. Shared by both Blender exports.
# The engraved frame is below the cover, so the moving frost masks every route.
engraving=material('Case_Engraving',(.57,.54,.50),.39,.12)
lip=material('Case_Engraving_Highlight',(.90,.87,.83),.25,.16)
inlay=material('Index_Inlay',(.67,.53,.40),.52,.04)
def case_point(px,py):return ((px-24)/997*5-2.5,(667-py)/661*3.7)
def route(name,pixels):
    points=[case_point(x,y) for x,y in pixels]
    channel('Case engraved '+name,points,-.075,.0045,engraving)
    channel('Case pressed lip '+name,[(x+.007,z-.009) for x,z in points],-.079,.004,lip)

# The top patch finishes at the case's top and front planes: no raised block.
x,z=case_point(92,26)
cut=cube('Temporary inlay recess',(x,-.100,z),(.25,.030,2*(3.7-z)+.002),core,0)
bpy.context.view_layer.objects.active=front_cover
mod=front_cover.modifiers.new('Flush index pocket','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cut
bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cut,do_unlink=True)
cube('Index flush inlay',(x,-.102,z),(.25,.002,2*(3.7-z)),inlay,.0008)

route('outer upper left',[(974,14),(35,14),(35,612)])
route('outer lower right',[(1011,64),(1011,655),(80,655)])
route('upper circuit',[(35,171),(54,171),(78,143),(78,76),(98,57),(172,57),
 (191,46),(383,46),(405,57),(598,57),(617,68),(650,68),(655,64),(650,57),
 (620,57),(605,44),(600,43),(596,47),(597,54),(614,67),(760,67),
 (779,53),(782,47),(778,43),(773,44),(757,57),(722,57),(719,61),(720,68),
 (763,68),(780,57),(894,57),(917,40),(973,40)])
route('left hook',[(68,47),(51,64),(51,105),(53,111),(60,113),(64,109),
 (64,70),(90,42),(128,42),(134,39),(135,34),(131,28),(119,28)])
route('inner frame',[(115,565),(115,84),(132,67),(948,67),(968,85),(968,162),
 (981,192),(981,550),(909,622),(131,622),(118,609),(118,590)])
route('lower return',[(128,629),(911,629),(985,556)])
route('bottom catch',[(793,652),(798,648),(890,648),(894,653),(1010,653)])

for label,px,py,start,end in [('upper right',999,37,0.30*math.pi,1.84*math.pi),
                            ('lower left',57,642,-.75*math.pi,.78*math.pi)]:
    x,z=case_point(px,py)
    # C-shaped shallow boss, tied into the pressed frame rather than a raised ring.
    for radius in [.104,.127]:
        points=[(x+radius*math.cos(start+(end-start)*i/64),
                 z+radius*math.sin(start+(end-start)*i/64)) for i in range(65)]
        channel('Case engraved screw boss '+label,points,-.076,.0045,engraving)
        channel('Case pressed screw boss '+label,[(a+.006,b-.008) for a,b in points],-.080,.004,lip)
    # A real opening leaves the flush metal head readable under a frosted cover.
    bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.082,depth=.06,
        location=(x,-.095,z),rotation=(math.pi/2,0,0))
    cut=bpy.context.object
    bpy.context.view_layer.objects.active=front_cover
    mod=front_cover.modifiers.new('Flush fastener opening','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cut
    bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cut,do_unlink=True)
    annular_profile('Countersunk washer '+label,x,z,
        [(.061,-.094),(.080,-.094),(.080,-.100),(.071,-.103),(.063,-.103),(.061,-.099)],lip,64)
    bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=.060,depth=.010,
        location=(x,-.098,z),rotation=(math.pi/2,0,0))
    head=bpy.context.object;head.name='Machined screw '+label;head.data.materials.append(metal)
    mod=head.modifiers.new('Head chamfer','BEVEL');mod.width=.003;mod.segments=3
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for angle in [-.22,math.pi/2-.22]:
        cut=cube('Temporary drive cutter',(x,-.103,z),(.069,.008,.014),core,.001)
        cut.rotation_euler.y=angle
        bpy.context.view_layer.objects.active=head
        mod=head.modifiers.new('Cross recessed drive','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cut
        bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cut,do_unlink=True)
    head.modifiers.new('Fastener normals','WEIGHTED_NORMAL')
